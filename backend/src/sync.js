import db from "./db.js";
import { getCustomersFromSheet } from "./odoo.js";
import geocode from "./geocode.js";
import path from "path";

/** =======================
 * Helpers
 * ======================= */
function normalizeCep(cep) {
  return String(cep || "").replace(/\D/g, "");
}

function cleanUF(value) {
  const uf = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return null;
  if (uf === "BR") return null;
  return uf;
}

function buildEnderecoCompleto({ logradouro, numero, bairro, cidade, uf, cep, pais }) {
  const cepLimpo = normalizeCep(cep);

  const parts = [
    logradouro?.trim(),
    numero?.trim(),
    bairro?.trim(),
    cidade?.trim(),
    cleanUF(uf),
    cepLimpo || null,
    (pais || "Brasil")?.trim(),
  ].filter(Boolean);

  const q = parts.join(", ").replace(/\s+/g, " ").trim();
  if (!q || q.toLowerCase() === "brasil") return null;

  return q;
}

/** =======================
 * Persistência do cursor de sincronização
 * ======================= */
async function ensureSyncStateTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id INT PRIMARY KEY,
      last_odoo_id INT NULL,
      last_entry_name VARCHAR(255) NULL,
      paused_since DATETIME NULL,
      paused_reason VARCHAR(255) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Garantir colunas (caso tabela já exista sem as novas colunas)
  try { await db.query(`ALTER TABLE sync_state ADD COLUMN paused_since DATETIME NULL`); } catch {}
  try { await db.query(`ALTER TABLE sync_state ADD COLUMN paused_reason VARCHAR(255) NULL`); } catch {}
}

async function getSyncCursor() {
  await ensureSyncStateTable();
  const [rows] = await db.query(`SELECT last_odoo_id, last_entry_name FROM sync_state WHERE id = 1 LIMIT 1`);
  return rows && rows[0] ? rows[0] : { last_odoo_id: null, last_entry_name: null };
}

async function setSyncCursor({ last_odoo_id = null, last_entry_name = null }) {
  await ensureSyncStateTable();
  await db.query(
    `INSERT INTO sync_state (id, last_odoo_id, last_entry_name)
     VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE last_odoo_id = VALUES(last_odoo_id), last_entry_name = VALUES(last_entry_name)`,
    [last_odoo_id, last_entry_name]
  );
}

async function setPause(reason = null) {
  await ensureSyncStateTable();
  await db.query(
    `INSERT INTO sync_state (id, paused_since, paused_reason)
     VALUES (1, NOW(), ?)
     ON DUPLICATE KEY UPDATE paused_since = NOW(), paused_reason = VALUES(paused_reason)`,
    [reason]
  );
}

async function clearPause() {
  await ensureSyncStateTable();
  await db.query(`UPDATE sync_state SET paused_since = NULL, paused_reason = NULL WHERE id = 1`);
}

async function getPauseState() {
  await ensureSyncStateTable();
  const [rows] = await db.query(`SELECT paused_since, paused_reason FROM sync_state WHERE id = 1 LIMIT 1`);
  return rows && rows[0] ? rows[0] : { paused_since: null, paused_reason: null };
}

let clearedPauseOnStartup = false;

/** =======================
 * Sync principal
 * ======================= */
export async function syncClientes() {
  console.log("🔄 Sincronizando clientes DO EXCEL + Odoo…");

  try {
    // Ao iniciar o processo (primeira execução após restart), limpa o pause
    if (!clearedPauseOnStartup) {
      await clearPause();
      clearedPauseOnStartup = true;
      console.log("🔁 Limpei estado de pausa (reinício detectado)");
    } else {
      // Se estiver pausado por erro de rede, aguardar até 7h para tentar novamente
      const pause = await getPauseState();
      if (pause?.paused_since) {
        const [rows] = await db.query(`SELECT TIMESTAMPDIFF(HOUR, ?, NOW()) AS diffh`, [pause.paused_since]);
        const diffh = rows && rows[0] ? rows[0].diffh : 0;
        if (diffh < 7) {
          console.log(`⏸️ Sincronização pausada por erro de rede (faltam ${7 - diffh}h para nova tentativa). Razão: ${pause.paused_reason || '-'}`);
          return; // não sincroniza ainda
        }
        // 7 horas ou mais: libera nova tentativa
        console.log("⏱️ 7h passadas desde a pausa. Tentando sincronizar novamente.");
        await clearPause();
      }
    }

    // 🔥 CAMINHO DO ARQUIVO EXCEL
    const filePath = path.resolve(process.cwd(), "clientes.xlsx");

    // ✅ BUSCA os clientes no Odoo a partir dos nomes na planilha
    const { requested, customers, notFound } = await getCustomersFromSheet(filePath, {
      equipmentColumn: "Itens do pedido",
    });

    console.log(`📄 Clientes na planilha: ${requested.length}`);
    if (notFound.length) {
      console.warn("⚠️ Clientes não encontrados no Odoo:", notFound);
    }

    function stripAccentsLocal(s) {
      return String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
    }

    function normalizeNameLocal(s) {
      return stripAccentsLocal(String(s || ""))
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function nameCandidatesLocal(original) {
      const raw = String(original || "").trim();
      if (!raw) return [];
      const cands = new Set();
      cands.add(raw);
      if (raw.includes(",")) {
        const [a, b] = raw
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (a) cands.add(a);
        if (b) cands.add(b);
      }
      return [...cands];
    }

    function findMatchingPartner(requestedName, partners) {
      const candidates = nameCandidatesLocal(requestedName)
        .map(normalizeNameLocal)
        .filter(Boolean);
      if (!candidates.length) return null;

      // exact match first
      for (const p of partners) {
        const pn = normalizeNameLocal(p.display_name || p.name || "");
        if (candidates.includes(pn)) return p;
      }

      // fuzzy: contains or contained
      const scores = [];
      for (const p of partners) {
        const pn = normalizeNameLocal(p.display_name || p.name || "");
        for (const c of candidates) {
          if (!pn || !c) continue;
          const score = pn.includes(c) || c.includes(pn) ? 1 : 0;
          if (score) scores.push({ p, score, len: pn.length });
        }
      }

      if (scores.length) {
        scores.sort((a, b) => b.score - a.score || b.len - a.len);
        return scores[0].p;
      }

      return null;
    }

    // Monta lista de itens com match no Odoo
    const itens = (requested || []).map((entry, idx) => {
      const partner = findMatchingPartner(entry.name, customers || []);
      return { idx, entry, partner };
    });

    // Lê cursor para retomar após último sincronizado
    const cursor = await getSyncCursor();
    let startIdx = 0;
    if (cursor?.last_odoo_id) {
      const pos = itens.findIndex((x) => x.partner && x.partner.id === cursor.last_odoo_id);
      if (pos >= 0) startIdx = pos + 1;
    } else if (cursor?.last_entry_name) {
      // fallback: compara por nome (normalizado)
      const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
      const lastN = norm(cursor.last_entry_name);
      const pos = itens.findIndex((x) => norm(x.entry?.name) === lastN);
      if (pos >= 0) startIdx = pos + 1;
    }

    if (startIdx > 0) {
      console.log(`⏩ Retomando sincronização a partir do índice ${startIdx} (após o último processado).`);
    }

    let interrupted = false;
    for (let i = startIdx; i < itens.length; i++) {
      const { entry, partner } = itens[i];
      const reqName = entry?.name;
      if (!partner) {
        console.warn(`⚠️ Não encontrado no Odoo: ${reqName}`);
        continue;
      }

      try {
        const ok = await processarCliente(partner, entry);
        if (ok) {
          // Atualiza cursor após sucesso
          await setSyncCursor({ last_odoo_id: partner.id, last_entry_name: reqName });
        }
      } catch (err) {
        const msg = String(err?.message || "");
        const code = err?.code;
        if (err?.name === "NominatimNetworkError" || msg.includes("Falha de rede no Nominatim")) {
          console.error("🛑 Parando sincronização por erro de rede do Nominatim:", code || msg);
          await setPause(code || msg);
          interrupted = true;
          break; // interrompe até que o sistema seja reiniciado
        }
        console.error("⚠️ Erro inesperado processando cliente:", msg);
      }
    }

    if (interrupted) {
      console.log("⛔ Sincronização interrompida (aguardando reinício do sistema).");
    } else {
      console.log("✅ Sincronização concluída!");
    }
  } catch (err) {
    console.error("❌ ERRO PRINCIPAL:", err);
  }
}

async function processarCliente(c, requestedEntry = null) {
  try {
    // --- Dados do Odoo ---
    const logradouro = c.street || "";
    const numero = c.l10n_br_endereco_numero || "";
    const complemento = c.street2 || "";
    const bairro = c.l10n_br_endereco_bairro || "";
    const cidade = c.city || "";

    // ⚠️ No Odoo, state_id[1] geralmente vem "São Paulo" (sem "(SP)")
    const estadoNome = c.state_id ? c.state_id[1] : "";
    const estadoSiglaOdoo =
      cleanUF(c.state_code) ||
      cleanUF(c.l10n_br_state_code) ||
      null;

    const cep = c.zip || "";
    const pais = c.country_id ? c.country_id[1] : "Brasil";

    // --- Monta query inicial (pode não ter UF ainda) ---
    const enderecoCompleto = buildEnderecoCompleto({
      logradouro,
      numero,
      bairro,
      cidade,
      uf: estadoSiglaOdoo, // pode ser null
      cep,
      pais,
    });

    if (requestedEntry) console.log(`🔎 Origem planilha: ${requestedEntry.name}`);

    console.log(
      `👤 Parceiro Odoo: [id=${c.id}] ${c.display_name || c.name || "-"} `
    );
    console.log(
      `   Endereço Odoo: ${c.street || "-"} ${c.l10n_br_endereco_numero || ""} ${
        c.street2 || ""
      } | ${c.l10n_br_endereco_bairro || "-"} | ${c.city || "-"} | ${
        estadoNome || "-"
      } | CEP=${c.zip || "-"} `
    );
    console.log(`📝 Query construída: ${enderecoCompleto || "(nenhum endereço construído)"}`);

    // --- Geocode ---
    const geo = enderecoCompleto
      ? await geocode(enderecoCompleto, normalizeCep(cep))
      : null;

    // ✅ AQUI é a correção principal:
    // Se o geocode normalizou com UF (ex: "... Maceió, AL, Brasil"),
    // usamos essa UF para salvar no banco.
    const ufFromGeocode =
      cleanUF(geo?.normalized?.uf) ||
      cleanUF(geo?.normalized?.estado) ||
      cleanUF(geo?.normalized?.state) ||
      cleanUF(geo?.normalized?.state_code) ||
      null;

    const estadoSiglaFinal = estadoSiglaOdoo || ufFromGeocode;

    // (Opcional) log pra bater o olho
    if (geo?.normalized) {
      console.log(
        `🧭 Normalizado: ${geo.normalized?.logradouro || "-"}, ${geo.normalized?.cidade || "-"}, ${
          geo.normalized?.uf || geo.normalized?.state_code || "-"
        }, ${geo.normalized?.pais || "Brasil"}`
      );
    }
    console.log(`🏷️ UF escolhida p/ salvar: ${estadoSiglaFinal || "(null)"}`);

    // procura por outros clientes que possam corresponder ao mesmo endereço normalizado
    async function findMatches() {
      const cepNorm = normalizeCep(geo?.normalized?.cep || cep);
      const conditions = [];
      const params = [];

      if (cepNorm) {
        conditions.push("REPLACE(cep, '-', '') = ?");
        params.push(cepNorm);
      }

      if (cidade) {
        conditions.push("LOWER(cidade) = ?");
        params.push(cidade.toLowerCase());
      }

      if (logradouro) {
        conditions.push("LOWER(logradouro) LIKE ?");
        params.push(`%${logradouro.toLowerCase()}%`);
      }

      if (conditions.length === 0) return [];

      const where = conditions.join(" OR ");
      const sql = `
          SELECT id, id_odoo, nome, cep, logradouro, cidade
          FROM clientes
          WHERE (id_odoo IS NULL OR id_odoo != ?)
            AND (${where})
          LIMIT 10
        `;

      const [rows] = await db.query(sql, [c.id, ...params]);
      return rows;
    }

    const matches = await findMatches();
    if (matches && matches.length) {
      console.log("🔎 Possíveis clientes com mesmo endereço:");
      for (const m of matches) {
        console.log(
          `  - [id=${m.id} | odoo=${m.id_odoo ?? "-"}] ${m.nome} | ${m.cep || "-"} | ${
            m.cidade || "-"
          } | ${m.logradouro || "-"} `
        );
      }
    } else {
      console.log("🔎 Nenhum outro cliente encontrado com esse endereço normalizado");
    }

    // --- Salvar cliente ---
    await db.query(
      `INSERT INTO clientes (
        id_odoo, nome, telefone, celular, email, site,
        logradouro, numero, complemento, bairro, cidade,
        estado, cep, pais, endereco_completo,
        latitude, longitude
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        nome=VALUES(nome),
        telefone=VALUES(telefone),
        celular=VALUES(celular),
        email=VALUES(email),
        site=VALUES(site),
        logradouro=VALUES(logradouro),
        numero=VALUES(numero),
        complemento=VALUES(complemento),
        bairro=VALUES(bairro),
        cidade=VALUES(cidade),
        estado=VALUES(estado),
        cep=VALUES(cep),
        pais=VALUES(pais),
        endereco_completo=VALUES(endereco_completo),
        latitude=VALUES(latitude),
        longitude=VALUES(longitude)
      `,
      [
        c.id,
        c.name,
        c.phone || "",
        c.mobile || "",
        c.email || "",
        c.website || "",
        logradouro,
        numero,
        complemento,
        bairro,
        cidade,
        estadoSiglaFinal, // ✅ agora salva UF vindo do geocode quando Odoo não tiver
        normalizeCep(cep),
        pais,
        enderecoCompleto,
        geo?.lat || null,
        geo?.lng || null,
      ]
    );

    // --- Persistir equipamentos (se houver dados na planilha) ---
    const equipmentRaw = String(requestedEntry?.equipment || "").trim();
    if (equipmentRaw) {
      // ensure table exists (table name: equipamentos)
      await db.query(`
        CREATE TABLE IF NOT EXISTS equipamentos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          cliente_id INT NOT NULL,
          nome VARCHAR(255) NOT NULL,
          quantidade INT DEFAULT NULL,
          UNIQUE KEY cliente_equip (cliente_id, nome)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // get local cliente id (by id_odoo)
      const [sel] = await db.query(`SELECT id FROM clientes WHERE id_odoo = ? LIMIT 1`, [c.id]);
      const clienteId = sel && sel[0] && sel[0].id;

      if (clienteId) {
        // clear existing equips for this cliente
        await db.query(`DELETE FROM equipamentos WHERE cliente_id = ?`, [clienteId]);

        // parse equipment string: split by comma/semicolon/pipe/newline
        const parts = equipmentRaw.split(/[;,\n|]+/).map((p) => p.trim()).filter(Boolean);

        function sanitizeEquipmentName(raw) {
          let s = String(raw || "").trim();
          // normalizar traços tipográficos
          s = s.replace(/[–—]/g, "-");

          // remover prefixos como "S/2025/63699 - "
          s = s.replace(/^[A-Za-z]\/[0-9]{4}\/[0-9]+\s*[-–—]\s*/i, "");

          // se houver bloco em colchetes, manter apenas o que vem DEPOIS dele
          const br = s.match(/\[[^\]]+\]\s*(.+)$/);
          if (br) s = br[1];

          // remover separadores/pontuação iniciais remanescentes
          s = s.replace(/^[\s\-–—:]+/, "");

          // colapsar espaços
          s = s.replace(/\s+/g, " ").trim();
          return s;
        }

        function parsePart(p) {
          // Captura quantidade no fim em formatos comuns: ' — 2', '- 2', 'x2', '(2)', '×2'
          const m = p.match(/^(.*?)(?:[\s\-–—x×\(*]*([0-9]+)\)?)?\s*$/i);
          let name = m ? String(m[1] || "").trim() : String(p || "").trim();
          const qty = m && m[2] ? parseInt(m[2], 10) || null : null;

          // higienização pedida: manter apenas o que vier após o bloco em colchetes [CÓDIGO]
          name = sanitizeEquipmentName(name);
          return { name, qty };
        }

        for (const part of parts) {
          const { name, qty } = parsePart(part);
          try {
            await db.query(
              `INSERT INTO equipamentos (cliente_id, nome, quantidade) VALUES (?, ?, ?)`,
              [clienteId, name, qty]
            );
          } catch (e) {
            // ignore duplicate/key errors
          }
        }
        console.log(`🧰 Equipamentos gravados para cliente_id=${clienteId}: ${parts.length}`);
      } else {
        console.log("⚠️ Não encontrou cliente local para associar equipamentos (id_odoo=", c.id, ")");
      }
    }
    return true;
  } catch (err) {
    const msg = String(err?.message || "");
    if (err?.name === "NominatimNetworkError" || msg.includes("Falha de rede no Nominatim")) {
      // Propaga erro fatal para parar a sincronização
      throw err;
    }
    console.error(`⚠️ Erro processando cliente ${c.name}:`, err);
    return false;
  }
}
