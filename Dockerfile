# Imagen Playwright alineada con tu versión 1.56.1
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copiamos package.json primero para aprovechar la cache
COPY package*.json ./
RUN npm ci

# Copiamos el resto del proyecto (incluye /local/storageState.json)
COPY . .

# Forzamos la ruta del storage en tiempo de ejecución (evita confusiones con Shared Variables)
ENV STORAGE_STATE_PATH=/app/local/storageState.json
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]