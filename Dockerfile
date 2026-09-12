FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY modules ./modules
COPY public ./public
COPY ai-足球竞技场-底层提示词与输出协议.md ./
COPY 竞彩玩法记录.md ./
COPY config/README.md ./config/README.md
COPY config/ai-models.js ./config/ai-models.js
COPY config/ai-models.env.example ./config/ai-models.env.example

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
