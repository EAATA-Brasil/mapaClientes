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
 * Sync principal
 * ======================= */
export async function syncClientes() {
  console.log("🔄 Sincronizando clientes DO EXCEL + Odoo…");

  try {
    // 🔥 CAMINHO DO ARQUIVO EXCEL
    const filePath = path.resolve(
      process.cwd(),
      "clientes.xlsx"
    );

    // ✅ BUSCA os clientes no Odoo a partir dos nomes na planilha
    const { requested, customers, notFound } = await getCustomersFromSheet(filePath);

    console.log(`📄 Clientes na planilha: ${requested.length}`);
    if (notFound.length) {
      console.warn("⚠️ Clientes não encontrados no Odoo:", notFound);
    }

    function stripAccentsLocal(s) {
      return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    }

    function normalizeNameLocal(s) {
      return stripAccentsLocal(String(s || "")).replace(/\s+/g, " ").trim().toLowerCase();
    }

    function nameCandidatesLocal(original) {
      const raw = String(original || "").trim();
      if (!raw) return [];
      const cands = new Set();
      cands.add(raw);
      if (raw.includes(",")) {
        const [a, b] = raw.split(",").map((x) => x.trim()).filter(Boolean);
        if (a) cands.add(a);
        if (b) cands.add(b);
      }
      return [...cands];
    }

    function findMatchingPartner(requestedName, partners) {
      const candidates = nameCandidatesLocal(requestedName).map(normalizeNameLocal).filter(Boolean);
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
          const score = (pn.includes(c) || c.includes(pn)) ? 1 : 0;
          if (score) scores.push({ p, score, len: pn.length });
        }
      }

      if (scores.length) {
        scores.sort((a, b) => b.score - a.score || b.len - a.len);
        return scores[0].p;
      }

      return null;
    }

    for (const entry of requested) {
      const reqName = entry.name;
      const partner = findMatchingPartner(reqName, customers || []);
      if (!partner) {
        console.warn(`⚠️ Não encontrado no Odoo: ${reqName}`);
        continue;
      }

      await processarCliente(partner, entry);
    }

    console.log("✅ Sincronização concluída!");
  } catch (err) {
    console.error("❌ ERRO PRINCIPAL:", err);
  }
}

async function processarCliente(c, requestedEntry = null) {
  try {
    const logradouro = c.street || "";
    const numero = c.l10n_br_endereco_numero || "";
    const complemento = c.street2 || "";
    const bairro = c.l10n_br_endereco_bairro || "";
    const cidade = c.city || "";

    const estadoCompleto = c.state_id ? c.state_id[1] : "";
    const estadoSiglaRaw = estadoCompleto.match(/\((.*?)\)/)?.[1] || "";
    const estadoSigla = cleanUF(estadoSiglaRaw);

    const cep = c.zip || "";
    const pais = c.country_id ? c.country_id[1] : "Brasil";

    const enderecoCompleto = buildEnderecoCompleto({
      logradouro,
      numero,
      bairro,
      cidade,
      uf: estadoSigla,
      cep,
      pais,
    });

    if (requestedEntry) console.log(`🔎 Origem planilha: ${requestedEntry.name}`);

    console.log(`👤 Parceiro Odoo: [id=${c.id}] ${c.display_name || c.name || '-'} `);
    console.log(`   Endereço Odoo: ${c.street || '-'} ${c.l10n_br_endereco_numero || ''} ${c.street2 || ''} | ${c.l10n_br_endereco_bairro || '-'} | ${c.city || '-'} | ${estadoCompleto || '-'} | CEP=${c.zip || '-'} `);
    console.log(`📝 Query construída: ${enderecoCompleto || '(nenhum endereço construído)'}`);

    const geo = enderecoCompleto
      ? await geocode(enderecoCompleto, normalizeCep(cep))
      : null;

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

        const where = conditions.join(' OR ');
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
        console.log('🔎 Possíveis clientes com mesmo endereço:');
        for (const m of matches) {
          console.log(`  - [id=${m.id} | odoo=${m.id_odoo ?? '-'}] ${m.nome} | ${m.cep || '-'} | ${m.cidade || '-'} | ${m.logradouro || '-'} `);
        }
      } else {
        console.log('🔎 Nenhum outro cliente encontrado com esse endereço normalizado');
      }

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
        estadoSigla,
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
      // ensure table exists (table name: Itens do pedido)
      await db.query(`\n        CREATE TABLE IF NOT EXISTS \`Itens do pedido\` (\n          id INT AUTO_INCREMENT PRIMARY KEY,\n          cliente_id INT NOT NULL,\n          nome VARCHAR(255) NOT NULL,\n          quantidade INT DEFAULT NULL,\n          UNIQUE KEY cliente_equip (cliente_id, nome)\n        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n      `);

      // get local cliente id (by id_odoo)
      const [sel] = await db.query(`SELECT id FROM clientes WHERE id_odoo = ? LIMIT 1`, [c.id]);
      const clienteId = sel && sel[0] && sel[0].id;

      if (clienteId) {
        // clear existing equips for this cliente
        await db.query(`DELETE FROM \`Itens do pedido\` WHERE cliente_id = ?`, [clienteId]);

        // parse equipment string: split by comma/semicolon/pipe/newline
        const parts = equipmentRaw.split(/[;,\n|]+/).map((p) => p.trim()).filter(Boolean);

        function parsePart(p) {
          // common forms: 'Equip X', 'Equipamento x2', 'Equip (2)'
          const m = p.match(/^(.*?)[\s\(x×*]*([0-9]+)\)?\s*$/i);
          if (m) {
            const name = m[1].trim();
            const qty = parseInt(m[2], 10) || null;
            return { name, qty };
          }
          return { name: p, qty: null };
        }

        for (const part of parts) {
          const { name, qty } = parsePart(part);
          try {
            await db.query(`INSERT INTO \`Itens do pedido\` (cliente_id, nome, quantidade) VALUES (?, ?, ?)`, [clienteId, name, qty]);
          } catch (e) {
            // ignore duplicate/key errors
          }
        }
        console.log(`🧰 Equipamentos gravados para cliente_id=${clienteId}: ${parts.length}`);
      } else {
        console.log('⚠️ Não encontrou cliente local para associar equipamentos (id_odoo=', c.id, ')');
      }
    }
  } catch (err) {
    console.error(`⚠️ Erro processando cliente ${c.name}:`, err);
  }
}
