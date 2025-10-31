# 🧱 Imagen base de Node con soporte Playwright estable
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# 📂 Definir directorio de trabajo
WORKDIR /app

# 🧾 Copiar archivos de dependencias primero (mejor caché)
COPY package*.json ./

# ⚙️ Instalar dependencias y Chromium con todas las librerías necesarias
RUN npm install && npx playwright install --with-deps chromium

# 📁 Copiar todo el código del proyecto
COPY . .

# 🔐 Definir variable de entorno con la ruta del storageState.json
ENV STORAGE_STATE_PATH=/app/local/storageState.json

# 🧹 Reducir tamaño de imagen eliminando caché innecesaria
RUN rm -rf /var/lib/apt/lists/* /root/.cache

# ⚡ Exponer el puerto donde corre Express
EXPOSE 3000

# 🚀 Comando de inicio del servidor
CMD ["npm", "start"]
