# syntax=docker/dockerfile:1

# ---- Compilación: React + Tailwind → archivos estáticos ------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Ejecución: nginx sirve la app y hace de proxy hacia el backend ------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
