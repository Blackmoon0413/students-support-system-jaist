import base64
import io
import logging
import threading
import time
from collections import deque

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import mediapipe as mp
from PIL import Image
import pytesseract

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class CalibrationPoint(BaseModel):
    x: float
    y: float

class OcrRequest(BaseModel):
    image_base64: str
    lang: str | None = None

class GazeTracker:
    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.thread = None
        self.feature_buffer = deque(maxlen=30)
        self.model = None
        self.samples = []
        self.latest_gaze = None
        self.cap = None

    def start(self):
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.cap is not None:
            self.cap.release()
            self.cap = None

    def _run(self):
        self.cap = cv2.VideoCapture(0)
        if not self.cap.isOpened():
            logger.error("Failed to open webcam. Is it in use by another app?")
            self.running = False
            return

        face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        try:
            while self.running:
                ok, frame = self.cap.read()
                if not ok:
                    time.sleep(0.05)
                    continue

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = face_mesh.process(rgb)

                if results.multi_face_landmarks:
                    landmarks = results.multi_face_landmarks[0].landmark
                    feature = self._extract_feature(landmarks)
                    if feature is not None:
                        with self.lock:
                            self.feature_buffer.append(feature)
                            if self.model is not None:
                                self.latest_gaze = self._predict(feature)
                time.sleep(0.01)
        finally:
            face_mesh.close()
            if self.cap is not None:
                self.cap.release()
                self.cap = None

    def _extract_feature(self, landmarks):
        def avg_point(indices):
            xs = [landmarks[i].x for i in indices]
            ys = [landmarks[i].y for i in indices]
            return sum(xs) / len(xs), sum(ys) / len(ys)

        left_iris = avg_point([468, 469, 470, 471])
        right_iris = avg_point([473, 474, 475, 476])

        left_outer = landmarks[33]
        left_inner = landmarks[133]
        right_outer = landmarks[362]
        right_inner = landmarks[263]

        def normalize(iris, outer, inner):
            min_x = min(outer.x, inner.x)
            max_x = max(outer.x, inner.x)
            min_y = min(outer.y, inner.y)
            max_y = max(outer.y, inner.y)
            width = max(max_x - min_x, 1e-6)
            height = max(max_y - min_y, 1e-6)
            nx = (iris[0] - min_x) / width
            ny = (iris[1] - min_y) / height
            return nx, ny

        left_norm = normalize(left_iris, left_outer, left_inner)
        right_norm = normalize(right_iris, right_outer, right_inner)

        return [left_norm[0], left_norm[1], right_norm[0], right_norm[1]]

    def _mean_feature(self):
        with self.lock:
            if not self.feature_buffer:
                return None
            features = list(self.feature_buffer)
        return list(np.mean(np.array(features), axis=0))

    def reset_calibration(self):
        with self.lock:
            self.samples = []
            self.model = None
            self.latest_gaze = None

    def add_calibration_sample(self, target):
        feature = self._mean_feature()
        if feature is None:
            raise ValueError("No face detected")
        with self.lock:
            self.samples.append((feature, target))
            if len(self.samples) >= 5:
                self._fit_model()

    def _fit_model(self):
        x_data = np.array([sample[0] + [1.0] for sample in self.samples])
        yx = np.array([sample[1][0] for sample in self.samples])
        yy = np.array([sample[1][1] for sample in self.samples])

        coef_x, _, _, _ = np.linalg.lstsq(x_data, yx, rcond=None)
        coef_y, _, _, _ = np.linalg.lstsq(x_data, yy, rcond=None)
        self.model = (coef_x, coef_y)

    def _predict(self, feature):
        if self.model is None:
            return None
        vec = np.array(feature + [1.0])
        x = float(np.dot(self.model[0], vec))
        y = float(np.dot(self.model[1], vec))
        return {
            "x": max(0.0, min(1.0, x)),
            "y": max(0.0, min(1.0, y)),
        }

    def get_gaze(self):
        with self.lock:
            return self.latest_gaze

    def is_calibrated(self):
        return self.model is not None

    def sample_count(self):
        return len(self.samples)

tracker = GazeTracker()

@app.on_event("startup")
def startup_event():
    tracker.start()

@app.on_event("shutdown")
def shutdown_event():
    tracker.stop()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/gaze")
def gaze_sample():
    gaze = tracker.get_gaze()
    if gaze is None:
        return {"x": 0.5, "y": 0.4, "calibrated": tracker.is_calibrated(), "source": "fallback"}
    return {"x": gaze["x"], "y": gaze["y"], "calibrated": tracker.is_calibrated(), "source": "mediapipe"}

@app.post("/calibrate/start")
def calibrate_start():
    tracker.reset_calibration()
    return {"status": "ready"}

@app.post("/calibrate/point")
def calibrate_point(point: CalibrationPoint):
    if not 0 <= point.x <= 1 or not 0 <= point.y <= 1:
        raise HTTPException(status_code=400, detail="Point must be normalized 0-1")
    try:
        tracker.add_calibration_sample([point.x, point.y])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "status": "captured",
        "samples": tracker.sample_count(),
        "calibrated": tracker.is_calibrated(),
    }

@app.get("/calibrate/status")
def calibrate_status():
    return {"samples": tracker.sample_count(), "calibrated": tracker.is_calibrated()}

@app.post("/ocr")
def ocr_focus(request: OcrRequest):
    try:
        data = request.image_base64
        if data.startswith("data:image"):
            data = data.split(",", 1)[1]
        image_bytes = base64.b64decode(data)
        image = Image.open(io.BytesIO(image_bytes))
        if request.lang:
            text = pytesseract.image_to_string(image, lang=request.lang)
        else:
            text = pytesseract.image_to_string(image)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OCR failed: {exc}") from exc

    return {"text": text}
