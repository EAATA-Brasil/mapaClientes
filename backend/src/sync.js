import db from "./db.js";
import { getCustomers } from "./odoo.js";
import geocode from "./geocode.js";

export async function syncClientes() {
  console.log("🔄 Sincronizando clientes do Odoo…");

  try {
    const clientes = await getCustomers();

    if (!Array.isArray(clientes)) {
      console.error("❌ Odoo retornou algo inesperado:", clientes);
      return;
    }

    // PROCESSAR UM POR VEZ — EVITA DEADLOCKS
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
    const numero = c.street2 || "";
    const complemento = "";
    const bairro = c.district || "";
    const cidade = c.city || "";
    const estadoCompleto = c.state_id ? c.state_id[1] : "";
    const estadoSigla =
      estadoCompleto.match(/\((.*?)\)/)?.[1] || "";
    const cep = c.zip || "";
    const pais = c.country_id ? c.country_id[1] : "Brasil";

    // SE O ENDEREÇO ESTÁ MUITO RUIM → IGNORA
    const enderecoCompleto = `${logradouro} ${numero}, ${bairro}, ${cidade}, ${estadoSigla}, ${cep}, ${pais}`
      .replace(/\s+/g, " ")
      .replace(/, ,/g, ",")
      .trim();

    if (enderecoCompleto.length < 10) {
      console.warn(`⚠️ Endereço inválido para ${c.name}, ignorando…`);
      return;
    }

    // GEOCODING
    const coords = await geocode(enderecoCompleto);

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
        coords?.lng || null
      ]
    );

  } catch (err) {
    console.error(`⚠️ Erro processando cliente ${c.name}:`, err);
  }
}
