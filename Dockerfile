# specify node.js image
FROM node:22-alpine

# use production node environment by default
ENV NODE_ENV=production

# Tofu (2026-10-25): a custom domain connected to the app on Tofu is served over HTTPS, so its short links are too.
# The owner can set CUSTOM_DOMAIN_USE_HTTPS=false to go back to upstream's default.
ENV CUSTOM_DOMAIN_USE_HTTPS=true

# set working directory.
WORKDIR /kutt

# download dependencies while using Docker's caching
# Tofu (2026-10-25): the package files are copied in rather than bind-mounted. Tofu's container hosting builds with
# buildah, and a cache mount is the one RUN --mount form a gallery image has been built with there so far.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

RUN mkdir -p /var/lib/kutt

# copy the rest of source files into the image
COPY . .

# expose the port that the app listens on
EXPOSE 3000

# intialize database and run the app
CMD npm run migrate && npm start
