# Stage 1: Install dependencies and build
FROM node:22-slim AS build

WORKDIR /app

# Copy package files and install all dependencies (including devDependencies for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .

# Accept NEXT_PUBLIC_* vars as build args so Next.js can inline them
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN

RUN npm run build

# Stage 2: Production image
FROM node:22-slim

WORKDIR /app

# Set correct permissions and switch to non-root user
RUN chown -R node:node /app
USER node

# Copy package files and install production dependencies only
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the Next.js build output from build stage
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/public ./public

# Copy service-account.json if present (for firebase-admin)
COPY --chown=node:node --from=build /app/service-account.json* ./

# Cloud Run sets PORT=8080 by default
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

CMD ["npm", "start"]
