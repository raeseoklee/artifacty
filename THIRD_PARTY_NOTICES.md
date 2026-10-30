# Third Party Notices

Artifacty includes CodeMirror 6 packages for the browser editor.

- CodeMirror and `@codemirror/*` packages are distributed under the MIT License.
- Lezer parser packages used by CodeMirror are distributed under the MIT License.

The installed package metadata and license files are retained through npm dependency installation.

## Bootstrap 5.3.8

Artifacty includes selected generated assets from this package.

The MIT License (MIT)

Copyright (c) 2011-2025 The Bootstrap Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


## Tabler Icons 3.49.0

Artifacty includes selected generated assets from this package.

MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Mermaid and ELK

The audited dependency snapshot uses Mermaid 12.2.0 (MIT) and elkjs 0.9.3
(Eclipse Public License 2.0). Mermaid distributes ELK layout code in its renderer
chunks. Preserve these notices when redistributing those files.

- [Mermaid license](licenses/mermaid-LICENSE.txt) and [corresponding source](https://github.com/mermaid-js/mermaid/tree/mermaid%4012.2.0).
- [ELK license](licenses/elkjs-LICENSE.txt) and [corresponding source](https://github.com/kieler/elkjs/tree/0.9.3).

Dependency versions can change within the package ranges. Review the resolved
versions and their license files before each release. Other installed dependencies
retain their own notices through npm installation, including DOMPurify
(MPL-2.0 OR Apache-2.0), caniuse-lite (CC-BY-4.0), and Khroma (MIT).

## Bundled multilingual-e5-small model

The default embedding model and tokenizer are from the original publisher,
`intfloat/multilingual-e5-small`, revision
`614241f622f53c4eeff9890bdc4f31cfecc418b3`. The publisher's
[model card at that revision](https://huggingface.co/intfloat/multilingual-e5-small/blob/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md)
declares the MIT license. The model, tokenizer data, and configuration are obtained
from this same repository; Artifacty does not redistribute the separately hosted
Xenova conversion.

- Source: [original model files](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx).
- Quantized weights: `onnx/model_qint8_avx512_vnni.onnx` (118,346,824 bytes).
- Weight SHA-256: `dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88`.
- Copyright: Microsoft Corporation. See the preserved [MIT license](licenses/multilingual-e5-small-LICENSE.txt).
- License text source: [Microsoft UniLM](https://github.com/microsoft/unilm/blob/31c5b904ca1bf2afb4c234a6675c683a4e5fc7cd/LICENSE), the source project linked by the model publisher.

Preserve the license and these source details when redistributing bundled model
files. A user-selected replacement model has its own terms; this notice does not
license or approve replacement models.

## Local embedding runtime

Hugging Face Tokenizers.js 0.2.0 is distributed under
[Apache License 2.0](licenses/tokenizers-js-LICENSE.txt).
[Corresponding source](https://github.com/huggingface/tokenizers.js/tree/v0.2.0).
Its npm package retains the publisher's license text.

Artifacty vendors four unmodified files from ONNX Runtime Web 1.30.0 under
`vendor/onnxruntime`: `ort.wasm.min.mjs`, its source map,
`ort-wasm-simd-threaded.mjs`, and
`ort-wasm-simd-threaded.wasm`. They run the WebAssembly CPU backend in a Node
worker. The runtime is distributed under the [MIT license](licenses/onnxruntime-LICENSE.txt)
with additional [third-party notices](licenses/onnxruntime-ThirdPartyNotices.txt).
[Corresponding source](https://github.com/microsoft/onnxruntime/tree/v1.30.0).
The vendored provenance record identifies the npm source archive and file hashes.
Preserve that record, the runtime copyright header, license, and third-party
notices when redistributing these files.

The upstream source map for `ort.wasm.min.mjs` lists only ONNX Runtime common and
WASM backend sources. Artifacty does not ship the WebGL bundle or the npm
`guid-typescript` dependency. Embedded native components in the WASM binary remain
subject to the preserved ONNX Runtime third-party notices; the runtime's MIT
license does not replace their terms.
