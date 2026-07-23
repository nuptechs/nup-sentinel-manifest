# Stage 1: Build Java analyzer engine
FROM maven:3.9-eclipse-temurin-17 AS java-build
WORKDIR /build
COPY java-analyzer-engine/pom.xml java-analyzer-engine/pom.xml
RUN cd java-analyzer-engine && mvn dependency:go-offline -q
COPY java-analyzer-engine/ java-analyzer-engine/
RUN cd java-analyzer-engine && mvn clean package -DskipTests -q

# Stage 2: Build Node.js app
FROM node:20-slim AS node-build
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build

# Stage 3: Runtime — Node 20 + JRE 17
FROM node:20-slim AS runtime

# Install JRE 17 for the Java analyzer engine
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Node.js production deps
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy built Node.js app
COPY --from=node-build /app/dist ./dist

# drizzle-kit push no pré-deploy (railway.toml) precisa do config + schema TS
# (o drizzle-kit lê TS com o esbuild embutido). Auditoria 2026-07-23: sem isto
# a liturgia era ALTER manual antes de cada coluna nova — furo operacional.
COPY drizzle.config.ts ./drizzle.config.ts
COPY shared ./shared

# Copy built Java analyzer JAR
COPY --from=java-build /build/java-analyzer-engine/target/java-analyzer-engine-1.0.0.jar \
    java-analyzer-engine/target/java-analyzer-engine-1.0.0.jar

# Verify Java is available
RUN java -version

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.cjs"]
