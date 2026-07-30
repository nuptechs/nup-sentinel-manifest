# Stage 1: Build Java analyzer engine (ADR-0023 O5 — Java 21, engine ÚNICO
# dual-entrypoint: HTTP AnalyzerServer + CLI `extract`). Testes RODAM no build
# (o engine ganhou suíte JUnit na consolidação — sem -DskipTests).
FROM maven:3.9-eclipse-temurin-21 AS java-build
WORKDIR /build
COPY java-analyzer-engine/pom.xml java-analyzer-engine/pom.xml
RUN cd java-analyzer-engine && mvn dependency:go-offline -q
COPY java-analyzer-engine/ java-analyzer-engine/
RUN cd java-analyzer-engine && mvn clean package -q

# Stage 2: Build Node.js app
FROM node:20-slim AS node-build
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build

# Stage 3: Runtime — Node 20 + JRE 21 (ADR-0023 O5)
FROM node:20-slim AS runtime

# JRE 21 via COPY do Temurin (bookworm não tem openjdk-21 no apt; a variante
# jammy roda no glibc 2.36 do bookworm — jammy é 2.35, compat pra frente).
COPY --from=eclipse-temurin:21-jre-jammy /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="$JAVA_HOME/bin:$PATH"

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
