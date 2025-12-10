import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS } = process.env;

async function odooRPC(method, params) {
  const payload = {
    jsonrpc: "2.0",
    method,
    params,
    id: Math.floor(Math.random() * 99999)
  };

  const res = await axios.post(ODOO_URL, payload, {
    headers: { "Content-Type": "application/json" }
  });

  if (res.data.error) throw res.data.error;

  return res.data.result;
}

export async function getCustomers() {
  const uid = await odooRPC("call", {
    service: "common",
    method: "login",
    args: [ODOO_DB, ODOO_USER, ODOO_PASS]
  });

  return odooRPC("call", {
    service: "object",
    method: "execute_kw",
    args: [
      ODOO_DB,
      uid,
      ODOO_PASS,
      "res.partner",
      "search_read",
      [[["customer_rank", ">", 0]]],
      {
        fields: [
          "name",
          "street",
          "street2",
          "zip",
          "city",
          "l10n_br_endereco_bairro",
          "state_id",
          "country_id",
          "phone",
          "mobile",
          "email",
          "website"
        ],
        limit: 5000
      }
    ]
  });
}
