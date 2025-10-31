# 🧱 Imagen base oficial de Node.js con Playwright compatible
FROM node:18-bullseye

# 📂 Definir directorio de trabajo dentro del contenedor
WORKDIR /app

# 🧾 Copiar archivos de dependencias
COPY package*.json ./

# ⚙️ Instalar dependencias y Chromium con sus librerías del sistema
RUN npm install && npx playwright install --with-deps chromium

# 📁 Copiar el resto del código (incluye carpeta local/)
COPY . .

# 🔐 Definir variable de entorno para la sesión TikTok
ENV STORAGE_STATE_PATH=/app/local/storageState.json

# ⚡ Exponer el puerto que usará el servidor Express
EXPOSE 3000

# 🚀 Comando de inicio del servidor
CMD ["npm", "start"]
