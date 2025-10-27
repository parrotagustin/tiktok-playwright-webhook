# Imagen base ligera con Node.js
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de configuración primero (para cache eficiente)
COPY package*.json ./

# Instala dependencias sin cache
RUN npm install --omit=dev

# Copia el resto del código fuente
COPY . .

# Expone el puerto (Railway usa PORT automáticamente)
EXPOSE 3000

# Comando para iniciar el servidor
CMD ["node", "server.js"]
