/**
 * ClientBase GitHub Auto-Deployer
 * Lessons learned from manual deployments:
 *
 *  1. Delete package-lock.json  — Windows lockfile locks Windows native binaries, breaks on Linux
 *  2. Write .npmrc with Linux platform  — forces @tailwindcss/oxide etc. to download Linux binaries
 *  3. Patch BrowserRouter → HashRouter  — BrowserRouter breaks when served from /sites/:id/ subpath
 *  4. Patch href="/#section" → href="#section"  — absolute hash links escape the site into the dashboard
 *  5. Auto-detect & install missing peer deps (e.g. @splinetool/runtime for react-spline)
 *  6. Build-retry loop  — if "failed to resolve import X", install X and retry (up to 3 times)
 *  7. --base ./ on Vite builds  — relative asset paths, essential for subpath hosting
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const db   = require('./db');

// ─── MIME Types ────────────────────────────────────────────────────────────────
function getMimeType(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
        'html': 'text/html', 'htm': 'text/html',
        'css':  'text/css',
        'js':   'text/javascript', 'mjs': 'text/javascript',
        'json': 'application/json',
        'png':  'image/png',  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif':  'image/gif',  'svg': 'image/svg+xml', 'webp': 'image/webp',
        'ico':  'image/x-icon',
        'woff': 'font/woff',  'woff2': 'font/woff2', 'ttf': 'font/ttf',
        'mp4':  'video/mp4',  'webm': 'video/webm',  'mp3': 'audio/mpeg',
        'txt':  'text/plain', 'xml': 'application/xml', 'pdf': 'application/pdf',
        'map':  'application/json',
    };
    return map[ext] || 'application/octet-stream';
}

// ─── Upload entire dist dir to a bucket ───────────────────────────────────────
function uploadDirectory(baseDir, dir, bucketId) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            uploadDirectory(baseDir, full, bucketId);
        } else {
            const buf = fs.readFileSync(full);
            db.prepare(
                'INSERT INTO files (id, bucketId, name, data, size, mimeType) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(crypto.randomUUID(), bucketId, entry.name, buf, buf.length, getMimeType(entry.name));
        }
    }
}

// ─── LESSON 3 + 4: Patch source for subpath hosting ──────────────────────────
// Scans all JS/TS/JSX/TSX files and:
//   • Replaces BrowserRouter with HashRouter (works at any URL depth)
//   • Fixes href="/#section" → href="#section" (keep links inside the site)
function patchSourceForSubpath(dir) {
    const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js']);
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out']);

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            patchSourceForSubpath(full);
        } else if (EXTS.has(path.extname(entry.name))) {
            let src = fs.readFileSync(full, 'utf-8');
            let changed = false;

            // BrowserRouter → HashRouter (import + JSX)
            if (src.includes('BrowserRouter')) {
                src = src
                    .replace(/\bBrowserRouter\b/g, 'HashRouter');
                changed = true;
            }

            // href="/#xxx" or href='/#xxx' → href="#xxx"
            if (src.includes('/#')) {
                src = src
                    .replace(/href=(["'])\/#!/g, 'href=$1#!')   // hash-style /#!
                    .replace(/href=(["'])\/#/g,  'href=$1#');   // regular /#section
                changed = true;
            }

            if (changed) fs.writeFileSync(full, src);
        }
    }
}

// ─── LESSON 5: Auto-install missing peer deps from npm install stderr ─────────
function extractMissingPeerDeps(npmOutput) {
    const missing = new Set();
    // npm v7+ format: "npm warn peer dep missing: <pkg>@version, required by ..."
    // npm v8+ format: "npm warn ERESOLVE ..."
    const re = /peer dep missing:\s*([^\s,@]+)/gi;
    let m;
    while ((m = re.exec(npmOutput)) !== null) {
        missing.add(m[1]);
    }
    return [...missing];
}

// ─── LESSON 6: Build with retry on missing imports ────────────────────────────
function buildWithRetry(tmpDir, buildCmd, buildEnv, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            execSync(buildCmd, {
                cwd: tmpDir, stdio: 'pipe', timeout: 240000, env: buildEnv
            });
            return; // success
        } catch (err) {
            const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');

            // Parse "Rollup failed to resolve import 'X' from ..."
            const importRe = /failed to resolve import ['"]([^'"]+)['"]/gi;
            const missing = new Set();
            let m;
            while ((m = importRe.exec(output)) !== null) {
                // Only install npm package names (ignore relative paths)
                const pkg = m[1];
                if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
                    // Extract the package name (handle scoped packages)
                    const pkgName = pkg.startsWith('@')
                        ? pkg.split('/').slice(0, 2).join('/')
                        : pkg.split('/')[0];
                    missing.add(pkgName);
                }
            }

            if (missing.size === 0 || attempt === maxRetries) {
                throw new Error(`Build failed (attempt ${attempt}/${maxRetries}):\n${output.slice(-2000)}`);
            }

            // Install missing packages and retry
            const toInstall = [...missing].join(' ');
            console.log(`[Deployer] Build attempt ${attempt} failed. Auto-installing: ${toInstall}`);
            execSync(`npm install ${toInstall} --no-save --legacy-peer-deps`, {
                cwd: tmpDir, stdio: 'pipe', timeout: 120000
            });
        }
    }
}

// ─── MAIN: Deploy from GitHub URL ─────────────────────────────────────────────
async function deployFromGitHub(repoUrl, siteName, projectId, envVars = {}) {
    const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    if (!match) throw new Error('Invalid GitHub URL. Expected: https://github.com/owner/repo');

    const repoPath   = match[1];
    const derivedName = siteName || repoPath.split('/')[1];
    const tmpDir     = path.join(process.cwd(), 'tmp', crypto.randomUUID());

    try {
        // ── Step 1: Clone ──────────────────────────────────────────────────────
        fs.mkdirSync(tmpDir, { recursive: true });
        execSync(`git clone --depth 1 https://github.com/${repoPath}.git "${tmpDir}"`, {
            stdio: 'pipe', timeout: 90000
        });

        // ── Step 2: Check for build system ────────────────────────────────────
        const pkgPath = path.join(tmpDir, 'package.json');
        let outputDir = tmpDir;

        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

            if (pkg.scripts?.build) {
                const hasVite = !!(pkg.devDependencies?.vite || pkg.dependencies?.vite ||
                    fs.existsSync(path.join(tmpDir, 'vite.config.ts')) ||
                    fs.existsSync(path.join(tmpDir, 'vite.config.js')));
                const hasCRA  = !!(pkg.dependencies?.['react-scripts']);
                const hasNext = !!(pkg.dependencies?.next || pkg.devDependencies?.next);

                if (hasNext) throw new Error(
                    'Next.js requires a Node.js server and cannot be deployed as a static site. Use Vercel instead.'
                );

                // ── LESSON 1+2: Clean install with Linux platform forced ────
                try { fs.rmSync(path.join(tmpDir, 'package-lock.json'), { force: true }); } catch (_) {}
                try { fs.rmSync(path.join(tmpDir, 'node_modules'), { recursive: true, force: true }); } catch (_) {}
                fs.writeFileSync(path.join(tmpDir, '.npmrc'),
                    'os=linux\ncpu=x64\nlibc=glibc\nloglevel=warn\n'
                );

                const installEnv = {
                    ...process.env, ...envVars,
                    npm_config_os: 'linux', npm_config_cpu: 'x64', npm_config_libc: 'glibc'
                };

                // Capture npm install output to detect missing peer deps
                let installOutput = '';
                try {
                    const res = spawnSync(
                        'npm', ['install', '--legacy-peer-deps', '--os', 'linux', '--cpu', 'x64', '--libc', 'glibc'],
                        { cwd: tmpDir, timeout: 180000, env: installEnv, encoding: 'utf-8' }
                    );
                    installOutput = (res.stdout || '') + (res.stderr || '');
                } catch (_) {}

                // ── LESSON 2: Safety net for @tailwindcss/oxide ───────────
                const oxidePath = path.join(tmpDir, 'node_modules', '@tailwindcss', 'oxide-linux-x64-gnu');
                if (!fs.existsSync(oxidePath)) {
                    try {
                        execSync('npm install @tailwindcss/oxide-linux-x64-gnu --no-save --legacy-peer-deps', {
                            cwd: tmpDir, stdio: 'pipe', timeout: 60000
                        });
                    } catch (_) {}
                }

                // ── LESSON 5: Install detected missing peer deps ───────────
                const missingPeers = extractMissingPeerDeps(installOutput);
                if (missingPeers.length > 0) {
                    console.log(`[Deployer] Auto-installing missing peer deps: ${missingPeers.join(', ')}`);
                    try {
                        execSync(`npm install ${missingPeers.join(' ')} --no-save --legacy-peer-deps`, {
                            cwd: tmpDir, stdio: 'pipe', timeout: 120000
                        });
                    } catch (_) {}
                }

                // ── LESSON 3+4: Patch BrowserRouter → HashRouter + fix links ─
                patchSourceForSubpath(tmpDir);

                // ── LESSON 7: Build with --base ./ + retry on missing imports ─
                const buildCmd = hasVite ? 'npx vite build --base ./'
                    : hasCRA              ? 'npm run build'
                    :                       'npm run build';
                const buildEnv = { ...process.env, ...envVars, NODE_ENV: 'production', PUBLIC_URL: './' };

                buildWithRetry(tmpDir, buildCmd, buildEnv);

                // Find output dir
                if      (fs.existsSync(path.join(tmpDir, 'dist')))  outputDir = path.join(tmpDir, 'dist');
                else if (fs.existsSync(path.join(tmpDir, 'build'))) outputDir = path.join(tmpDir, 'build');
                else if (fs.existsSync(path.join(tmpDir, 'out')))   outputDir = path.join(tmpDir, 'out');
            }
        }

        // ── Step 3: Upload to bucket ───────────────────────────────────────────
        const bucketId = crypto.randomUUID();
        db.prepare('INSERT INTO buckets (id, projectId, name) VALUES (?, ?, ?)').run(
            bucketId, projectId, `${derivedName}-bucket`
        );
        uploadDirectory(outputDir, outputDir, bucketId);

        const fileCount = db.prepare('SELECT COUNT(*) as c FROM files WHERE bucketId = ?').get(bucketId).c;

        // ── Step 4: Create website record ─────────────────────────────────────
        const siteId = crypto.randomUUID();
        db.prepare('INSERT INTO websites (id, projectId, name, bucketId, domain, enabled) VALUES (?, ?, ?, ?, ?, ?)')
            .run(siteId, projectId, derivedName, bucketId, `${derivedName}.clientbase`, 1);

        return {
            success: true,
            siteId,
            name: derivedName,
            url: `/sites/${siteId}`,
            filesUploaded: fileCount,
            repo: `https://github.com/${repoPath}`
        };

    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

module.exports = { deployFromGitHub };
