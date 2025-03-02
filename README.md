# Motion detector
A wasm module that detects motion in a video stream from a webcam directly in the browser.

## build
To build the module, you need to have `wasm-pack` installed. You can install it using `cargo`:
```bash
cargo install wasm-pack
```

Then you can build the module using:
```bash
wasm-pack build --target web
```

## usage
Just launch a small web server in the root of the project and open the browser at `http://localhost:8000` or whatever port you choose.
When motion is detected, a small div will become red and say "Motion detected". Also screenreader users will hear "Motion detected".

## demo
Not available yet.

## license
MIT
