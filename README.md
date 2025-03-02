# Motion detector
A wasm module that detects motion in a video stream from a webcam directly in the browser.

## Note
This is a work in progress. The module is not yet working properly.

## build
To build the module, you need to have `wasm-pack` installed. You can install it using `cargo`:
```bash
cargo install wasm-pack
```

Then you can build the module using:
```bash
wasm-pack build --target web
```

to publish on your website, you can copy the pkg, all html, css and js files to your server. Or simply copy the whole folder with this repo (prebuilt) to your server, delete .git and target folders and you are good to go.

## simple usage
Just launch a small web server in the root of the project and open the browser at `http://localhost:8000` or whatever port you choose.
When motion is detected, a small div will become red and say "Motion detected". Also screenreader users will hear "Motion detected".




## demo
Not available yet.

## license
MIT
