import axios from "axios";
import dotenv from "dotenv";
import xlsx from "xlsx";

dotenv.config();

/**
 * ENV obrigatórias:
 * ODOO_URL=https://seu-odoo.com/jsonrpc
 * ODOO_DB=nome_do_banco
 * ODOO_USER=usuario
 * ODOO_PASS=senha
 */
const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS } = process.env;

// ✅ Se TRUE: só retorna clientes (customer_rank > 0)
// Se FALSE: retorna qualquer res.partner que bater (contatos também)
const ONLY_CUSTOMERS = true;

// tamanho de lote para buscas exatas com IN
const CHUNK_SIZE = 200;

// limite de candidatos por busca fuzzy (ilike)
const FUZZY_LIMIT = 5;

/* ======================================================
   JSON-RPC BASE
====================================================== */
async function odooRPC(method, params) {
  const payload = {
    jsonrpc: "2.0",
    method,
    params,
    id: Math.floor(Math.random() * 99999),
  };

  const res = await axios.post(ODOO_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });

  if (res.data.error) {
    throw new Error(JSON.stringify(res.data.error, null, 2));
  }

  return res.data.result;
}

async function odooLogin() {
  return odooRPC("call", {
    service: "common",
    method: "login",
    args: [ODOO_DB, ODOO_USER, ODOO_PASS],
  });
}

/* ======================================================
   STRING HELPERS (acentos, normalização)
====================================================== */
function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeName(s) {
  return stripAccents(s)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Gera candidatos a partir do texto da planilha:
 * - "Empresa, Pessoa" -> tenta:
 *    - "Empresa, Pessoa"
 *    - "Empresa"
 *    - "Pessoa"
 */
function nameCandidates(original) {
  const raw = String(original || "").trim();
  if (!raw) return [];

  const candidates = new Set();
  candidates.add(raw);

  if (raw.includes(",")) {
    const [a, b] = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (a) candidates.add(a);
    if (b) candidates.add(b);
  }

  return [...candidates];
}

/* ======================================================
   LER PLANILHA E EXTRAIR CLIENTES
====================================================== */
/**
 * - Lê a coluna "Cliente"
 * - Preenche células vazias herdando o valor de cima (fill down)
 * - Remove duplicados
 */
function readCustomersFromXlsx(
  filePath,
  { sheetName, customerColumn = "Cliente", equipmentColumn = "Equipamentos" } = {}
) {
  const workbook = xlsx.readFile(filePath);
  const worksheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];

  if (!worksheet) {
    throw new Error("Aba da planilha não encontrada");
  }

  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
  if (!rows.length) return [];

  // Encontrar a coluna Cliente e Equipamento (case-insensitive)
  const keys = Object.keys(rows[0] || {});
  const customerKey = keys.find(
    (k) => k.trim().toLowerCase() === customerColumn.toLowerCase()
  );
  const equipmentKey = keys.find(
    (k) => k.trim().toLowerCase() === equipmentColumn.toLowerCase()
  );

  if (!customerKey) {
    throw new Error(
      `Coluna "${customerColumn}" não encontrada. Colunas disponíveis: ${keys.join(", ")}`
    );
  }

  let lastCustomer = "";
  let lastEquipment = "";
  const customers = [];
  const seen = new Map();

  function mergeEquipment(a, b) {
    if (!a && !b) return "";
    const parts = [];
    if (a) parts.push(...String(a).split(/[;,\n|]+/));
    if (b) parts.push(...String(b).split(/[;,\n|]+/));
    const s = parts.map((p) => String(p).trim()).filter(Boolean);
    return [...new Set(s)].join("; ");
  }

  for (const row of rows) {
    let name = String(row[customerKey] ?? "").trim();
    let equip = equipmentKey ? String(row[equipmentKey] ?? "").trim() : "";

    // fill-down for both columns
    if (!name) name = lastCustomer;
    if (name) lastCustomer = name;

    if (!equip) equip = lastEquipment;
    if (equip) lastEquipment = equip;

    if (!name) continue;

    if (seen.has(name)) {
      const idx = seen.get(name);
      customers[idx].equipment = mergeEquipment(customers[idx].equipment, equip);
    } else {
      seen.set(name, customers.length);
      customers.push({ name, equipment: equip || "" });
    }
  }

  return customers;
}

/* ======================================================
   MATCH HELPERS (marcar found/notFound corretamente)
====================================================== */
function buildFoundKeySet(partners) {
  const set = new Set();

  for (const p of partners) {
    const dn = normalizeName(p.display_name || "");
    const nm = normalizeName(p.name || "");
    if (dn) set.add(dn);
    if (nm) set.add(nm);
  }

  return set;
}

function isRequestedFound(requestedName, foundKeySet) {
  // tenta bater por candidatos:
  // - "Empresa, Pessoa"
  // - "Empresa"
  // - "Pessoa"
  const cands = nameCandidates(requestedName).map(normalizeName).filter(Boolean);
  return cands.some((c) => foundKeySet.has(c));
}

/* ======================================================
   BUSCAR CLIENTES NO ODOO
====================================================== */
export async function getCustomersFromSheet(
  filePath,
  { sheetName, customerColumn = "Cliente", equipmentColumn = "Equipamentos" } = {}
) {
  const uid = await odooLogin();

  const requestedEntries = readCustomersFromXlsx(filePath, {
    sheetName,
    customerColumn,
    equipmentColumn,
  });

  const requested = requestedEntries.map((r) => r.name);

  if (!requested.length) {
    return { customers: [], notFound: [], requested: [] };
  }

  const FIELDS = [
    "id",
    "name",
    "display_name",
    "street",
    "street2",
    "zip",
    "city",
    "l10n_br_endereco_bairro",
    "l10n_br_endereco_numero",
    "state_id",
    "country_id",
    "phone",
    "mobile",
    "email",
    "website",
    "customer_rank",
    "parent_id",
  ];

  const results = [];

  // ---------------------------
  // PASSO 1) EXATO (IN)
  // ---------------------------
  for (let i = 0; i < requested.length; i += CHUNK_SIZE) {
    const chunk = requested.slice(i, i + CHUNK_SIZE);

    // tenta bater pelo display_name OU name (match exato)
    let domain = ["|", ["display_name", "in", chunk], ["name", "in", chunk]];

    if (ONLY_CUSTOMERS) {
      domain = ["&", ["customer_rank", ">", 0], ...domain];
    }

    const data = await odooRPC("call", {
      service: "object",
      method: "execute_kw",
      args: [
        ODOO_DB,
        uid,
        ODOO_PASS,
        "res.partner",
        "search_read",
        [domain],
        { fields: FIELDS, limit: 100000 },
      ],
    });

    if (Array.isArray(data) && data.length) results.push(...data);
  }

  // calcula notFound com base em name/display_name normalizados
  let foundKeys = buildFoundKeySet(results);
  let notFound = requested.filter((r) => !isRequestedFound(r, foundKeys));

  // ---------------------------
  // PASSO 2) FUZZY (ILIKE) só pros que sobraram
  // ---------------------------
  if (notFound.length) {
    const fuzzyFound = [];

    for (const missing of notFound) {
      const candidates = nameCandidates(missing);

      // monta OR encadeado com display_name ilike / name ilike para cada candidato
      const conds = [];
      for (const cand of candidates) {
        if (!cand) continue;

        // ilike é case-insensitive, mas ainda pode sofrer com acentos.
        // Mesmo assim, geralmente resolve a maioria.
        conds.push(["display_name", "ilike", cand]);
        conds.push(["name", "ilike", cand]);
      }

      if (!conds.length) continue;

      // encadear OR: | c1 | c2 | c3 ...
      let fuzzyDomain = conds[0];
      for (let k = 1; k < conds.length; k++) {
        fuzzyDomain = ["|", fuzzyDomain, conds[k]];
      }

      if (ONLY_CUSTOMERS) {
        fuzzyDomain = ["&", ["customer_rank", ">", 0], ...fuzzyDomain];
      }

      const guess = await odooRPC("call", {
        service: "object",
        method: "execute_kw",
        args: [
          ODOO_DB,
          uid,
          ODOO_PASS,
          "res.partner",
          "search_read",
          [fuzzyDomain],
          { fields: FIELDS, limit: FUZZY_LIMIT },
        ],
      });

      if (Array.isArray(guess) && guess.length) {
        // escolhe o mais provável por “proximidade” simples
        const target = normalizeName(missing);

        guess.sort((a, b) => {
          const an = normalizeName(a.display_name || a.name);
          const bn = normalizeName(b.display_name || b.name);

          const ascore = an.includes(target) || target.includes(an) ? 2 : 0;
          const bscore = bn.includes(target) || target.includes(bn) ? 2 : 0;

          // desempate: maior string (mais “completa”)
          return bscore - ascore || (bn.length - an.length);
        });

        fuzzyFound.push(guess[0]);
      }
    }

    // adiciona resultados fuzzy, evitando duplicar por id
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const r of fuzzyFound) byId.set(r.id, r);

    const merged = [...byId.values()];

    // recalcula notFound final
    foundKeys = buildFoundKeySet(merged);
    notFound = requested.filter((r) => !isRequestedFound(r, foundKeys));

    return { requested: requestedEntries, customers: merged, notFound };
  }

  return { requested: requestedEntries, customers: results, notFound };
}

/* ======================================================
   EXECUÇÃO DIRETA (opcional)
====================================================== */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const filePath = "./clientes.xlsx";

  getCustomersFromSheet(filePath, { customerColumn: "Cliente" })
    .then(({ requested, customers, notFound }) => {
      console.log("📄 Clientes na planilha:", requested.length);
      console.log("✅ Encontrados no Odoo:", customers.length);
      console.log("❌ Não encontrados:", notFound.length);
      if (notFound.length) console.log(notFound.slice(0, 50));
    })
    .catch((err) => {
      console.error("Erro:", err.message);
    });
}
