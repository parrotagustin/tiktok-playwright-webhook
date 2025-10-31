# Imagen base ligera con Node y soporte Playwright
FROM mcr.microsoft.com/playwright:v1.46.0-focal

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias Node sin volver a instalar Chromium (ya viene incluido)
RUN npm ci

# Copiar el resto del proyecto
COPY . .

# Exponer el puerto dinámico que Railway asigna
ENV PORT=8080
EXPOSE 8080

# Comando de ejecución
CMD ["npm", "start"]
