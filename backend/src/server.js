import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";
import { syncClientes } from "./sync.js";
import dotenv from "dotenv";
dotenv.config();

// Necessário para resolver caminhos em ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Servir todos os arquivos estáticos dentro de /frontend
app.use(express.static(path.join(__dirname, "../../frontend")));

// Rota API
app.get("/clientes", async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM clientes WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
  );

  if (!rows || !rows.length) return res.json([]);

  try {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const [items] = await db.query(
      `SELECT cliente_id, nome, quantidade FROM equipamentos WHERE cliente_id IN (${placeholders})`,
      ids
    );

    const itemsByClient = new Map();
    items.forEach(it => {
      if (!itemsByClient.has(it.cliente_id)) itemsByClient.set(it.cliente_id, []);
      itemsByClient.get(it.cliente_id).push({ nome: it.nome, quantidade: it.quantidade });
    });

    const result = rows.map(r => ({ ...r, equipamentos: itemsByClient.get(r.id) || [] }));
    res.json(result);
  } catch (err) {
    console.warn('Erro ao buscar equipamentos (talvez tabela ausente):', err.message || err);
    // fallback: return clients without equipamentos
    res.json(rows.map(r => ({ ...r, equipamentos: [] })));
  }
});

// Rota Padrão → entregar index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/index.html"));
});

// // Sincroniza ao iniciar
syncClientes();

// // Sincroniza a cada 20 minutos
setInterval(syncClientes, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em: http://localhost:${PORT}`));
