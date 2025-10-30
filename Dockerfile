FROM node:18-slim

WORKDIR /usr/src/app

# copy file cấu hình trước để cache layer
COPY package*.json ./

# dùng npm install (không dùng npm ci) + tránh lỗi peer deps
RUN npm install --omit=dev --legacy-peer-deps

# copy phần còn lại của mã nguồn
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]

