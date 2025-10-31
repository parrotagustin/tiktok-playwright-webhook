# Imagen oficial de Playwright que incluye Chromium
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Establecer directorio de trabajo
WORKDIR /app

# Copiar dependencias primero (para aprovechar cache)
COPY package*.json ./

# Instalar dependencias Node
RUN npm ci

# Copiar el resto del código
COPY . .

# Variables de entorno
ENV PORT=8080
ENV STORAGE_STATE_PATH=/app/local/storageState.json

# Exponer puerto
EXPOSE 8080

# Comando de ejecución
CMD ["npm", "start"]
