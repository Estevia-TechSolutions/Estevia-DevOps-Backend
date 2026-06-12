FROM node:20-alpine

# Set node environment to production
ENV NODE_ENV=production

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 5005

# Run application
CMD ["node", "server.js"]
