# Verwende ein leichtes Node.js Image
FROM node:18-alpine

# Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# Package Files kopieren (für besseres Caching)
COPY package*.json ./

# Abhängigkeiten installieren
RUN npm install --production

# Den Rest des Codes kopieren
COPY . .

# Port freigeben (muss mit dem in server.js übereinstimmen)
EXPOSE 8080

# Startbefehl
CMD ["npm", "start"]