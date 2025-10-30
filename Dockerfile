FROM node:18-slim

WORKDIR /usr/src/app

# copy file cấu hình trước để cache layer tốt hơn
COPY package*.json ./

# cài deps (production), bỏ peer deps tránh lỗi build
RUN npm ci --omit=dev --legacy-peer-deps

# copy phần còn lại của mã nguồn
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
