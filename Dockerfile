# Imagen oficial Playwright con Chromium preinstalado
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Instalar dependencias primero (cache más efectiva)
COPY package*.json ./
RUN npm ci

# Copiar el resto del código (incluye /local con cookies)
COPY . .

# Variables de entorno por defecto
ENV PORT=8080
ENV STORAGE_DIR=/app/local
# si no se especifica account en el body, usaremos este archivo:
ENV STORAGE_STATE_PATH=/app/local/storageState.json

EXPOSE 8080
CMD ["npm", "start"]
