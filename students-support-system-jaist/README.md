# students-support-system-jaist
powered by jaist

Windows Desktop: PDF + Gaze Focus + OCR + LLM

Goal
- Upload a PDF, track gaze focus with a webcam, visualize focus, OCR the focused text, and generate an explanation via GPT/LLM.

Target platform
- Windows 10/11 desktop.

MVP Scope
- PDF import and rendering.
- Webcam gaze estimation with 5-point calibration.
- Focus heatmap overlay on the PDF.
- OCR on the focused region.
- LLM summary/explanation from OCR text.

Recommended stack (Windows-first)
- UI: Electron + React (or plain JS) + PDF.js.
- Vision: Python backend (FastAPI) using MediaPipe Face Mesh for gaze estimation.
- OCR: PaddleOCR or Tesseract (local).
- LLM: OpenAI-compatible API (remote) or local LLM.

High-level architecture
- Electron app renders PDF and shows heatmap overlay.
- Python service reads webcam, estimates gaze, and emits screen coords.
- Electron receives gaze points, maps to PDF coords, and accumulates heatmap.
- Electron requests OCR on focused region and sends text to LLM API.
- LLM response is shown in a side panel.

Data flow
- Camera -> Face Mesh -> Gaze point (screen coords) -> PDF coords
- PDF coords -> Heatmap + Crop image -> OCR text -> LLM -> Explanation

Calibration
- 5-point calibration on first run or per session.
- Fit a regression from eye landmarks to screen coords.

Milestones
1) PDF render + scrolling + coordinate mapping
2) Webcam capture + gaze estimation + calibration
3) Heatmap overlay
4) OCR for focused region
5) LLM integration and UI panel

Open questions
- Gaze accuracy target (coarse region vs near eye-tracker precision).
- Offline vs online OCR/LLM.

Next steps
- Confirm tech stack preference (Electron + Python or full Python/Qt).
- Define LLM provider and OCR engine.
