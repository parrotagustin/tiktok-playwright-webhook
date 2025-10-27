# Usa una imagen oficial de Node.js
FROM node:18-bullseye

# Instala las librerías necesarias para Playwright + Chromium
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Configura el directorio de trabajo
WORKDIR /app

# Copia los archivos del proyecto
COPY . .

# Instala las dependencias de Node
RUN npm install

# Instala los navegadores de Playwright (solo Chromium)
RUN npx playwright install --with-deps chromium

# Expone el puerto
EXPOSE 8080

# Comando para ejecutar la app
CMD ["node", "server.js"]
