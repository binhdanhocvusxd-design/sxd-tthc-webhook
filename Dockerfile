FROM node:18-slim
WORKDIR /usr/src/app

# Cài deps trước để tối ưu cache
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

# Copy code
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
