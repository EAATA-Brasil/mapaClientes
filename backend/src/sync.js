import db from "./db.js";
import { getCustomers } from "./odoo.js";
import geocode from "./geocode.js";

/** =======================
 * Helpers
 * ======================= */
function normalizeCep(cep) {
  return String(cep || "").replace(/\D/g, "");
}

function cleanUF(value) {
  const uf = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return null;
  if (uf === "BR") return null; // BR é país, não UF
  return uf;
}

function buildEnderecoCompleto({ logradouro, numero, bairro, cidade, uf, cep, pais }) {
  const cepLimpo = normalizeCep(cep);

  const parts = [
    logradouro?.trim(),
    numero?.trim(),
    bairro?.trim(),
    cidade?.trim(),
    cleanUF(uf), // ✅ só entra UF válida
    cepLimpo || null,
    (pais || "Brasil")?.trim(),
  ].filter(Boolean);

  const q = parts.join(", ").replace(/\s+/g, " ").trim();

  // bloqueia "Brasil" sozinho ou muito vazio
  const semPontuacao = q.replace(/[, ]/g, "");
  if (!q || q.toLowerCase() === "brasil" || semPontuacao.length < 8) return null;

  return q;
}

function buildEnderecoFromNormalized(norm, fallbackPais = "Brasil") {
  if (!norm) return null;

  const parts = [
    norm.logradouro,
    norm.numero,
    norm.bairro,
    norm.cidade,
    cleanUF(norm.uf),
    normalizeCep(norm.cep),
    norm.pais || fallbackPais,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter(Boolean);

  const q = parts.join(", ").replace(/\s+/g, " ").trim();
  if (!q || q.toLowerCase() === "brasil") return null;
  return q;
}

/** =======================
 * Sync
 * ======================= */
export async function syncClientes() {
  console.log("🔄 Sincronizando clientes do Odoo…");

  try {
    const clientes = await getCustomers();

    if (!Array.isArray(clientes)) {
      console.error("❌ Odoo retornou algo inesperado:", clientes);
      return;
    }

    // processa um por vez
    for (const c of clientes) {
      await processarCliente(c);
    }

    console.log("✅ Sincronização concluída!");
  } catch (err) {
    console.error("❌ ERRO PRINCIPAL:", err);
  }
}

async function processarCliente(c) {
  try {
    // dados crus do Odoo
    const logradouro = c.street || "";
    const numero = c.l10n_br_endereco_numero || "";
    const complemento = c.street2 || "";
    const bairro = c.l10n_br_endereco_bairro || "";
    const cidade = c.city || "";

    const estadoCompleto = c.state_id ? c.state_id[1] : "";
    const estadoSiglaRaw = estadoCompleto.match(/\((.*?)\)/)?.[1] || "";
    const estadoSigla = cleanUF(estadoSiglaRaw); // ✅ se vier BR, vira null

    const cep = c.zip || "";
    const pais = c.country_id ? c.country_id[1] : "Brasil";

    // monta query inicial (sem BR como UF)
    const enderecoCompleto = buildEnderecoCompleto({
      logradouro,
      numero,
      bairro,
      cidade,
      uf: estadoSigla, // pode ser null
      cep,
      pais,
    });

    if (!enderecoCompleto) {
      console.warn(`⚠️ Endereço muito incompleto para ${c.name}, ignorando geocode…`);
      // Mesmo assim: salva cliente SEM estado (não coloca BR)
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
          null, // ✅ não grava BR nunca
          normalizeCep(cep) || null,
          pais || "Brasil",
          null,
          null,
          null,
        ]
      );
      return;
    }

    // ✅ chama geocode (ViaCEP + Nominatim)
    const geo = await geocode(enderecoCompleto, normalizeCep(cep));
    const norm = geo?.normalized || {};

    // ✅ UF final: SEMPRE prioriza normalizado (ViaCEP)
    const estadoFinal = cleanUF(norm.uf) || estadoSigla || null;

    // ✅ se vier normalizado, atualiza também os campos do endereço
    const logradouroFinal = String(norm.logradouro || logradouro || "").trim() || null;
    const numeroFinal = String(norm.numero || numero || "").trim() || null;
    const bairroFinal = String(norm.bairro || bairro || "").trim() || null;
    const cidadeFinal = String(norm.cidade || cidade || "").trim() || null;
    const cepFinal = normalizeCep(norm.cep || cep) || null;
    const paisFinal = String(norm.pais || pais || "Brasil").trim() || "Brasil";

    const enderecoNormalizado =
      buildEnderecoFromNormalized(
        {
          logradouro: logradouroFinal,
          numero: numeroFinal,
          bairro: bairroFinal,
          cidade: cidadeFinal,
          uf: estadoFinal,
          cep: cepFinal,
          pais: paisFinal,
        },
        paisFinal
      ) || enderecoCompleto;

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
        estado=VALUES(estado),              -- ✅ aqui entra MT/SP etc. (nunca BR)
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
        logradouroFinal,
        numeroFinal,
        complemento,
        bairroFinal,
        cidadeFinal,
        estadoFinal,              // ✅ UF correta
        cepFinal,
        paisFinal,
        enderecoNormalizado,      // ✅ sem BR se normalizado vier
        geo?.lat || null,
        geo?.lng || null,
      ]
    );
  } catch (err) {
    console.error(`⚠️ Erro processando cliente ${c.name}:`, err);
  }
}
