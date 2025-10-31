# Imagen Playwright alineada con tu package.json (1.56.1)
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Instala deps primero para cache
COPY package*.json ./
RUN npm ci

# Copia el resto del proyecto (incluye /local)
COPY . .

# Evita depender de variables compartidas mal seteadas
ENV STORAGE_STATE_PATH=/app/local/storageState.json
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
