FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./ 
RUN npm install --production
COPY src ./src
COPY env.sample ./env.sample
EXPOSE 3000
# WICHTIG: Verwende absoluten Pfad, um Pfadprobleme zu vermeiden
CMD ["node", "src/app.js"]
