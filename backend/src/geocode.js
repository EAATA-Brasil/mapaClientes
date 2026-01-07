import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;

// ===== helpers =====
const sleep = async (ms, reason = "") => {
  const sec = (ms / 1000).toFixed(1);
  console.log(`⏳ Aguardando ${sec}s ${reason ? `→ ${reason}` : ""}`);
  return new Promise(r => setTimeout(r, ms));
};

const axiosNominatim = axios.create({
  timeout: 30000, // ⏱️ 30 segundos
  headers: {
    "User-Agent": "EAATA-Mapa/1.0 (contato@eaata.pro)",
    "Accept": "application/json"
  },
  validateStatus: status => status >= 200 && status < 500
});

async function nominatimGet(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    console.log(`🌍 Nominatim tentativa ${i + 1}/${tries}`);
    const res = await axiosNominatim.get(url);

    // sucesso
    if (res.status === 200 && Array.isArray(res.data)) {
      console.log("✅ Nominatim respondeu com sucesso");
      return res;
    }

    // 429 / 503 → espera e tenta de novo
    if (res.status === 429 || res.status === 503) {
      const wait = 3000 * (i + 1); // 3s, 6s, 9s
      await sleep(wait, `Nominatim retornou ${res.status}`);
      continue;
    }

    // outros erros → não adianta insistir
    console.log(`⚠️ Nominatim retornou status ${res.status}, abortando`);
    return res;
  }

  console.log("❌ Nominatim falhou após todas as tentativas");
  return null;
}

export default async function geocode(endereco, cep) {
  try {
    // 🐢 pausa inicial
    await sleep(1500, "pausa entre chamadas");

    // 1️⃣ CEP via ViaCEP
    if (cep && cep.replace(/\D/g, "").length === 8) {
      console.log(`📮 Consultando ViaCEP: ${cep}`);
      const cepLimpo = cep.replace(/\D/g, "");
      const viaCepUrl = `https://viacep.com.br/ws/${cepLimpo}/json/`;

      const via = await axios.get(viaCepUrl, { timeout: 15000 });

      if (!via.data.erro) {
        const logradouro = via.data.logradouro || "";
        const bairro = via.data.bairro || "";
        const cidade = via.data.localidade || "";
        const estado = via.data.uf || "SP";

        const enderecoViaCep = `${logradouro}, ${bairro}, ${cidade}, ${estado}, Brasil`;
        console.log(`🏠 Endereço normalizado: ${enderecoViaCep}`);

        // 2️⃣ Google (opcional)
        if (GOOGLE_KEY) {
          console.log("🧭 Tentando Google Geocoding");
          const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoViaCep)}&key=${GOOGLE_KEY}`;
          const gRes = await axios.get(gUrl, { timeout: 30000 });

          if (gRes.data.results?.length > 0) {
            console.log("✅ Google retornou coordenadas");
            const loc = gRes.data.results[0].geometry.location;
            return { lat: loc.lat, lng: loc.lng };
          }
        }

        // 3️⃣ Nominatim
        const nominatimUrl =
          `https://nominatim.openstreetmap.org/search` +
          `?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(enderecoViaCep)}`;

        const nRes = await nominatimGet(nominatimUrl);

        if (nRes?.data?.length > 0) {
          console.log("📍 Coordenadas obtidas via Nominatim");
          return {
            lat: parseFloat(nRes.data[0].lat),
            lng: parseFloat(nRes.data[0].lon)
          };
        }
      }
    }

    // 4️⃣ Fallback texto
    if (!endereco || endereco.trim().length < 6) {
      console.log("⚠️ Endereço muito curto, ignorando");
      return null;
    }

    await sleep(1500, "pausa antes do fallback");

    console.log(`📝 Geocoding fallback: ${endereco}`);
    const fallback =
      `https://nominatim.openstreetmap.org/search` +
      `?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(endereco)}`;

    const fRes = await nominatimGet(fallback);

    if (fRes?.data?.length > 0) {
      console.log("📍 Coordenadas obtidas via fallback");
      return {
        lat: parseFloat(fRes.data[0].lat),
        lng: parseFloat(fRes.data[0].lon)
      };
    }

    console.log("❌ Nenhuma coordenada encontrada");
    return null;

  } catch (err) {
    console.error("🔥 Erro no geocode:", err.message || err);
    return null;
  }
}
