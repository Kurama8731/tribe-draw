
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: "super-secret-session-key",
  resave: false,
  saveUninitialized: false
}));

app.use("/public", express.static(path.join(__dirname, "public")));

// Screenshots Ordner erstellen falls nicht vorhanden
const screenshotsDir = path.join(__dirname, "public", "screenshots");
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

let state = {
  clanA: { tag: "", members: [] },
  clanB: { tag: "", members: [] },
  pool: [],
  winners: []
};

// USERS (für Schulprojekt fix im Code)
const users = [
  { user: "admin", role: "admin", pass: bcrypt.hashSync("admin123", 10) },
  { user: "uploader", role: "uploader", pass: bcrypt.hashSync("upload123", 10) }
];

// ===== AUTH =====
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const u = users.find(x => x.user === username);
  if (!u) return res.json({ ok: false });

  const ok = await bcrypt.compare(password, u.pass);
  if (!ok) return res.json({ ok: false });

  req.session.user = { user: u.user, role: u.role };
  res.json({ ok: true, role: u.role });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/state", (req, res) => {
  res.json(state);
});

// ===== UPLOAD =====
const upload = multer({ dest: "uploads/" });

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.session.user || !["admin", "uploader"].includes(req.session.user.role))
    return res.status(403).send("Forbidden");

  const wb = XLSX.readFile(req.file.path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  state.clanA.tag = rows[0][0];
  state.clanB.tag = rows[0][1];
  state.clanA.members = [];
  state.clanB.members = [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0]) state.clanA.members.push(rows[i][0]);
    if (rows[i][1]) state.clanB.members.push(rows[i][1]);
  }

  state.pool = [...state.clanA.members.map(n => ({ n, c: state.clanA.tag })),
                ...state.clanB.members.map(n => ({ n, c: state.clanB.tag }))];

  state.winners = [];
  fs.unlinkSync(req.file.path);

  res.json({ ok: true, count: state.pool.length });
});

// ===== DRAW =====
app.post("/api/draw", requireRole("admin"), (req, res) => {
  const count = Math.max(1, Math.floor(Number(req.body.count || 20)));
  const shuffled = [...state.pool].sort(() => 0.5 - Math.random());
  state.winners = shuffled.slice(0, Math.min(count, shuffled.length));
  res.json({ ok: true, winners: state.winners });
});

// ===== CLEAR WINNERS =====
app.post("/api/clear-winners", requireRole("admin"), (req, res) => {
  state.winners = [];
  res.json({ ok: true });
});

// ===== CLEAR LIST =====
app.post("/api/clear-list", requireRole("admin"), (req, res) => {
  state.clanA = { tag: "", members: [] };
  state.clanB = { tag: "", members: [] };
  state.pool = [];
  state.winners = [];
  res.json({ ok: true });
});

// ===== OLD WINNERS SCREENSHOTS =====
const screenshotUpload = multer({ 
  dest: screenshotsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Nur Bilddateien erlaubt!'));
    }
  }
});

app.post("/api/upload-screenshot", requireRole("admin"), screenshotUpload.single("screenshot"), (req, res) => {
  if (!req.file) return res.status(400).send("Keine Datei hochgeladen");
  
  const ext = path.extname(req.file.originalname);
  const newName = `winner-${Date.now()}${ext}`;
  const newPath = path.join(screenshotsDir, newName);
  
  fs.renameSync(req.file.path, newPath);
  res.json({ ok: true, filename: newName });
});

app.get("/api/screenshots", (req, res) => {
  try {
    const files = fs.readdirSync(screenshotsDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(screenshotsDir, a));
        const statB = fs.statSync(path.join(screenshotsDir, b));
        return statB.mtime - statA.mtime; // Neueste zuerst
      });
    res.json({ screenshots: files });
  } catch (e) {
    res.json({ screenshots: [] });
  }
});

app.delete("/api/screenshots/:filename", requireRole("admin"), (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(screenshotsDir, filename);
  
  // Sicherheitscheck: Nur Dateien im screenshots Ordner
  if (!filepath.startsWith(screenshotsDir)) {
    return res.status(403).send("Forbidden");
  }
  
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.json({ ok: true });
    } else {
      res.status(404).send("Datei nicht gefunden");
    }
  } catch (e) {
    res.status(500).send("Fehler beim Löschen: " + e.message);
  }
});


// ===== PAGES =====
app.get("/", (_, res) => res.redirect("/public/view.html"));
app.get("/admin", (_, res) => res.redirect("/public/admin.html"));
app.get("/login", (_, res) => res.redirect("/public/login.html"));

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
