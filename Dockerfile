# Stage 1: Pre-processamento (Build)
# Aqui usamos memória à vontade para converter o JSON em Binário
FROM node:22 AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

# Copia os dados e o script de pre-processamento
COPY references/references.json.gz ./references/
COPY scripts/pre-process.js ./scripts/

# Executa a conversão (vai gastar ~1GB de RAM aqui, mas apenas no build)
RUN node scripts/pre-process.js

# Stage 2: Runtime (Aplicação)
# Aqui seremos extremamente econômicos
FROM node:22-slim

WORKDIR /app

# Copia apenas os binários gerados
COPY --from=builder /app/references/*.bin ./references/
COPY src/ ./src/
COPY package.json ./

# Expõe a porta
EXPOSE 3000

# Comando para rodar
CMD ["node", "src/main.js"]
