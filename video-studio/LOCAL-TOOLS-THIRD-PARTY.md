# TrivexaAI Video Studio — Local Tools Third-Party Notices

The following optional components are downloaded by the browser only when the user first starts the relevant local tool. User video and audio files are processed in the user's browser tab and are not uploaded to TrivexaAI's AI Worker by these tools.

## MediaPipe Tasks Vision

- Package: `@mediapipe/tasks-vision@1.2.3`
- Purpose: on-device object detection and person segmentation for Motion Tracking, Auto Reframe and Person Background Removal.
- Package license: Apache License 2.0.
- Package source: https://www.npmjs.com/package/@mediapipe/tasks-vision
- Developer documentation: https://developers.google.com/edge/mediapipe/solutions/vision
- Model assets are fetched directly from Google's MediaPipe model storage. The editor does not redistribute the model binaries.

## EfficientDet-Lite0 Object Detector

- Model asset: `efficientdet_lite0/int8/1/efficientdet_lite0.tflite`
- Purpose: detect common COCO objects (including people) for tracking and reframing.
- Upstream asset information and license: https://huggingface.co/litert-community/MediaPipe-ObjectDetector-EfficientDet-Lite0
- Google-hosted model URL: https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite

## MediaPipe Selfie Segmenter (Landscape)

- Model asset: `selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite`
- Purpose: person/background segmentation only. It is not a general object-removal model.
- Google-hosted model URL: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite
- Model binaries remain hosted by Google and are fetched at runtime; consult Google's current model asset terms before redistributing them.

## RNNoise

- JavaScript/WebAssembly package: `@jitsi/rnnoise-wasm@0.2.1`
- Package license: Apache License 2.0.
- Underlying RNNoise source project: BSD 3-Clause license.
- Purpose: local speech-focused background-noise suppression; not full mastering, equalisation or music restoration.
- Sources: https://github.com/jitsi/rnnoise-wasm and https://github.com/xiph/rnnoise

## FFmpeg.wasm

- JavaScript wrapper: `@ffmpeg/ffmpeg@0.12.15` (MIT).
- WebAssembly core: `@ffmpeg/core@0.12.10`.
- Purpose: local short-clip reverse-video processing.
- The FFmpeg core's license obligations depend on the enabled FFmpeg build options and codecs. The editor downloads the official core at runtime and does not commit or redistribute that binary.
- Sources: https://github.com/ffmpegwasm/ffmpeg.wasm and https://ffmpeg.org/legal.html

## Network and cost notes

- These tools do not call a paid AI API or the TrivexaAI Cloudflare Worker.
- First use requires an internet connection to fetch the relevant open-source runtime/model files from their upstream CDNs or Google-hosted model storage.
- After the browser has cached those files, repeat use may avoid downloading them again; browser cache policies can still clear or refresh them.
- "Free" refers to the absence of a per-request TrivexaAI API charge. Upstream hosting, browser support, licence terms and service availability remain governed by each provider.
