# Development image. It runs Vite's dev server, which is also what proxies
# /api to the backend -- so the browser makes same-origin requests and no CORS
# is involved anywhere in the local stack.
#
# A production image would be a two-stage build ending in a static file server;
# there is no such deployment yet, and the one that exists (GitHub Pages) is
# served from the committed frontend/mock/ instead.

FROM node:24-alpine AS dev

WORKDIR /srv

# Dependencies first, so a source edit does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
