FROM node:20-slim
WORKDIR /app

# Install dependencies first
COPY package.json package-lock.json* ./
RUN npm ci --silent || npm install

# Copy the rest
COPY . .

# Build for production
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]