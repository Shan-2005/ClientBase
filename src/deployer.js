const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

// Simple MIME type lookup — no extra dependency needed
function getMimeType(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
        'html': 'text/html', 'htm': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript', 'mjs': 'text/javascript',
        'json': 'application/json',
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
        'ico': 'image/x-icon',
        'woff': 'font/woff', 'woff2': 'font/woff2', 'ttf': 'font/ttf',
        'mp4': 'video/mp4', 'webm': 'video/webm', 'mp3': 'audio/mpeg',
        'txt': 'text/plain', 'xml': 'application/xml', 'pdf': 'application/pdf',
        'map': 'application/json',
    };
    return map[ext] || 'application/octet-stream';
}

// Recursively upload all files from a directory into a ClientBase bucket
function uploadDirectory(baseDir, dir, bucketId) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            uploadDirectory(baseDir, fullPath, bucketId);
        } else {
            const buffer = fs.readFileSync(fullPath);
            const mimeType = getMimeType(entry.name);
            const fileId = crypto.randomUUID();
            db.prepare(
                'INSERT INTO files (id, bucketId, name, data, size, mimeType) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(fileId, bucketId, entry.name, buffer, buffer.length, mimeType);
        }
    }
}

async function deployFromGitHub(repoUrl, siteName, projectId, envVars = {}) {
    // Parse GitHub URL → owner/repo
    const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    if (!match) throw new Error('Invalid GitHub URL. Expected: https://github.com/owner/repo');

    const repoPath = match[1];
    const derivedName = siteName || repoPath.split('/')[1];

    // Unique temp dir inside the project (will be cleaned up)
    const tmpDir = path.join(process.cwd(), 'tmp', crypto.randomUUID());

    try {
        // ── Step 1: Clone ──────────────────────────────────────────────
        fs.mkdirSync(tmpDir, { recursive: true });
        execSync(
            `git clone --depth 1 https://github.com/${repoPath}.git "${tmpDir}"`,
            { stdio: 'pipe', timeout: 90000 }
        );

        // ── Step 2: Detect if build is needed ─────────────────────────
        const pkgPath = path.join(tmpDir, 'package.json');
        let outputDir = tmpDir;

        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

            if (pkg.scripts && pkg.scripts.build) {
                // Detect framework
                const hasVite = !!(pkg.devDependencies?.vite || pkg.dependencies?.vite ||
                    fs.existsSync(path.join(tmpDir, 'vite.config.ts')) ||
                    fs.existsSync(path.join(tmpDir, 'vite.config.js')));

                const hasCRA = !!(pkg.dependencies?.['react-scripts']);
                const hasNext = !!(pkg.dependencies?.next || pkg.devDependencies?.next);

                if (hasNext) throw new Error('Next.js requires server-side rendering. Use Vercel for Next.js projects.');

                // Fix @tailwindcss/oxide + other native optional dep bugs:
                // 1. Remove package-lock.json (locked to wrong platform from Windows checkout)
                // 2. Remove stale node_modules
                // 3. Write .npmrc to force Linux x64 glibc binary downloads
                try { fs.rmSync(path.join(tmpDir, 'package-lock.json'), { force: true }); } catch (_) {}
                try { fs.rmSync(path.join(tmpDir, 'node_modules'), { recursive: true, force: true }); } catch (_) {}
                fs.writeFileSync(path.join(tmpDir, '.npmrc'),
                    'os=linux\ncpu=x64\nlibc=glibc\nloglevel=error\n'
                );

                // Install with clean slate
                execSync('npm install --legacy-peer-deps', {
                    cwd: tmpDir, stdio: 'pipe', timeout: 180000,
                    env: { ...process.env, ...envVars, npm_config_os: 'linux', npm_config_cpu: 'x64', npm_config_libc: 'glibc' }
                });

                // Build with relative base so paths work under /sites/:id/
                let buildCmd = 'npm run build';
                if (hasVite) buildCmd = 'npx vite build --base ./';
                if (hasCRA)  buildCmd = 'npm run build';

                execSync(buildCmd, {
                    cwd: tmpDir, stdio: 'pipe', timeout: 180000,
                    env: { ...process.env, ...envVars, NODE_ENV: 'production', PUBLIC_URL: './' }
                });

                // Find output folder
                if (fs.existsSync(path.join(tmpDir, 'dist')))       outputDir = path.join(tmpDir, 'dist');
                else if (fs.existsSync(path.join(tmpDir, 'build'))) outputDir = path.join(tmpDir, 'build');
                else if (fs.existsSync(path.join(tmpDir, 'out')))   outputDir = path.join(tmpDir, 'out');
            }
        }

        // ── Step 3: Create bucket + upload all built files ────────────
        const bucketId = crypto.randomUUID();
        db.prepare('INSERT INTO buckets (id, projectId, name) VALUES (?, ?, ?)').run(
            bucketId, projectId, `${derivedName}-bucket`
        );
        uploadDirectory(outputDir, outputDir, bucketId);

        const fileCount = db.prepare('SELECT COUNT(*) as c FROM files WHERE bucketId = ?').get(bucketId).c;

        // ── Step 4: Create website entry ──────────────────────────────
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
        // Always clean up temp folder
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

module.exports = { deployFromGitHub };
