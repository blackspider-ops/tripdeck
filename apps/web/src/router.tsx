import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

// Phone (docs/03 §3) — owned by src/phone
const Landing = lazy(() => import("./phone/screens/Landing"));
const Create = lazy(() => import("./phone/screens/Create"));
const Join = lazy(() => import("./phone/screens/Join"));
const Demo = lazy(() => import("./phone/screens/Demo"));
const TripShell = lazy(() => import("./phone/screens/TripShell"));
// Headset + gallery (docs/03 §4–5) — owned by src/xr and src/gallery
const PairPage = lazy(() => import("./xr/PairPage"));
const XRPage = lazy(() => import("./xr/XRPage"));
const GalleryPage = lazy(() => import("./gallery/GalleryPage"));

export function AppRouter() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="boot">Plotting…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/new" element={<Create />} />
          <Route path="/join" element={<Join />} />
          <Route path="/demo" element={<Demo />} />
          <Route path="/xr" element={<PairPage />} />
          <Route path="/t/:code/xr" element={<XRPage />} />
          <Route path="/t/:code/gallery" element={<GalleryPage />} />
          {/* TripShell owns /t/:code, /muster, /brief, /wait, /table, /dryrun, /seal, /booked, /voided */}
          <Route path="/t/:code/*" element={<TripShell />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
