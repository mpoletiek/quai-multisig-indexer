FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built output
COPY dist ./dist

# Run the indexer
CMD ["node", "dist/index.js"]
