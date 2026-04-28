# Use Node.js 18 slim image
FROM node:18-slim

# Install build dependencies for better-sqlite3 + git for GitHub deployments
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Create data and storage directories
RUN mkdir -p data storage

# Set environment variables for storage (as used in server.js and db.js)
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV STORAGE_DIR=/app/storage

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
