import db from "./db.js";
import { getCustomers } from "./odoo.js";
import geocode from "./geocode.js";

function buildEnderecoCompleto({ logradouro, numero, bairro, cidade, uf, cep, pais }) {
  const cepLimpo = (cep || "").replace(/\D/g, "");

  const parts = [
    logradouro?.trim(),
    numero?.trim(),
    bairro?.trim(),
    cidade?.trim(),
    uf?.trim(),
    cepLimpo || null,
    (pais || "Brasil")?.trim(),
  ].filter(Boolean);

  const q = parts.join(", ").replace(/\s+/g, " ").trim();

  // bloqueia "Brasil" sozinho ou muito vazio
  const semPontuacao = q.replace(/[, ]/g, "");
  if (!q || q === "Brasil" || semPontuacao.length < 8) return null;

  return q;
}

export async function syncClientes() {
  console.log("🔄 Sincronizando clientes do Odoo…");

  try {
    const clientes = await getCustomers();

    if (!Array.isArray(clientes)) {
      console.error("❌ Odoo retornou algo inesperado:", clientes);
      return;
    }

    // PROCESSAR UM POR VEZ
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
    const logradouro = c.street || "";
    const numero = c.l10n_br_endereco_numero || "";
    const complemento = c.street2 || "";

    // ✅ bairro correto
    const bairro = c.l10n_br_endereco_bairro || "";

    const cidade = c.city || "";
    const estadoCompleto = c.state_id ? c.state_id[1] : "";
    const estadoSigla = estadoCompleto.match(/\((.*?)\)/)?.[1] || "";

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

    if (!enderecoCompleto) {
      console.warn(`⚠️ Endereço muito incompleto para ${c.name}, ignorando geocode…`);
      return;
    }

    // ✅ passa o CEP para ativar ViaCEP no geocode
    const coords = await geocode(enderecoCompleto, cep);

    await db.query(
      `INSERT INTO clientes (
        id_odoo, nome, telefone, celular, email, site,
        logradouro, numero, complemento, bairro, cidade,
        estado, cep, pais, endereco_completo,
        latitude, longitude
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        telefone=VALUES(telefone),
        celular=VALUES(celular),
        email=VALUES(email),
        site=VALUES(site),
        bairro=VALUES(bairro),
        cidade=VALUES(cidade),
        estado=VALUES(estado),
        cep=VALUES(cep),
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
        cep,
        pais,
        enderecoCompleto,
        coords?.lat || null,
        coords?.lng || null,
      ]
    );
  } catch (err) {
    console.error(`⚠️ Erro processando cliente ${c.name}:`, err);
  }
}
