FROM rust:1.85-bookworm AS build
WORKDIR /workspace
COPY . .
RUN cargo build --release --locked -p dama-example-rust-api

FROM debian:bookworm-slim
COPY --from=build /workspace/target/release/dama-example-rust-api /usr/local/bin/server
ARG DAMA_BASE_PATH=""
ENV DAMA_BASE_PATH=$DAMA_BASE_PATH PORT=8080
USER 10001:10001
EXPOSE 8080
CMD ["server"]
