# Usa la imagen oficial de Playwright con Chromium ya instalado
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copiar dependencias primero (para cache)
COPY package*.json ./

# Instalar dependencias del proyecto
RUN npm ci

# Copiar el resto del código (incluye /local)
COPY . .

# Variables de entorno
ENV PORT=8080
ENV STORAGE_STATE_PATH=/app/local/storageState.json

# Exponer puerto para Railway
EXPOSE 8080

# Comando de inicio
CMD ["npm", "start"]
