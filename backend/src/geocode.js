import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;

// ===== helpers =====
const sleep = async (ms, reason = "") => {
  const sec = (ms / 1000).toFixed(1);
  console.log(`⏳ Aguardando ${sec}s ${reason ? `→ ${reason}` : ""}`);
  return new Promise((r) => setTimeout(r, ms));
};

function isRetryableNetworkError(err) {
  const code = err?.code;
  const msg = (err?.message || "").toLowerCase();

  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    msg.includes("socket hang up") ||
    msg.includes("timeout") ||
    msg.includes("network")
  );
}

// ===== configs =====
const NOMINATIM_HOSTS = [
  "https://nominatim.openstreetmap.org"
];

// intervalo entre chamadas ao nominatim (1.5s ainda é agressivo)
const BASE_DELAY_MS = 3000; // 3s

const axiosNominatim = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent": "EAATA-Mapa/1.0 (contato@eaata.pro)",
    Accept: "application/json",
  },
  validateStatus: (status) => status >= 200 && status < 500,
});

async function viaCepGet(cepLimpo, tries = 3) {
  const url = `https://viacep.com.br/ws/${cepLimpo}/json/`;

  for (let i = 0; i < tries; i++) {
    try {
      await sleep(800 * (i + 1), "rate-limit ViaCEP");
      return await axios.get(url, { timeout: 20000 });
    } catch (err) {
      const code = err?.code || err?.message;
      console.log(`⚠️ ViaCEP falhou (${i + 1}/${tries}): ${code}`);

      if (isRetryableNetworkError(err)) {
        await sleep(2000 * (i + 1), `retry ViaCEP ${code}`);
        continue;
      }

      throw err;
    }
  }

  return null;
}

async function nominatimSearch(query, tries = 4) {
  for (const base of NOMINATIM_HOSTS) {
    for (let i = 0; i < tries; i++) {
      console.log(`🌍 Nominatim (${base}) tentativa ${i + 1}/${tries}`);

      // sempre espera um pouco entre chamadas
      await sleep(BASE_DELAY_MS, "rate-limit Nominatim");

      const url =
        `${base}/search?format=json&limit=1&countrycodes=br&addressdetails=0` +
        `&q=${encodeURIComponent(query)}`;

      try {
        const res = await axiosNominatim.get(url);

        if (res.status === 200 && Array.isArray(res.data)) {
          console.log("✅ Nominatim respondeu com sucesso");
          return res;
        }

        if (res.status === 429 || res.status === 503) {
          const backoff = 4000 * (i + 1); // 4s, 8s, 12s...
          await sleep(backoff, `Nominatim retornou ${res.status}`);
          continue;
        }

        console.log(`⚠️ Nominatim retornou status ${res.status} (trocando host)`);
        break; // troca host
      } catch (err) {
        const code = err?.code || err?.message;
        console.log(`⚠️ Falha de rede no Nominatim: ${code}`);

        if (isRetryableNetworkError(err)) {
          const backoff = 4000 * (i + 1);
          await sleep(backoff, `erro de rede ${code}`);
          continue;
        }

        break; // troca host
      }
    }
  }

  console.log("❌ Todos os hosts Nominatim falharam");
  return null;
}

export default async function geocode(endereco, cep) {
  try {
    // pausa geral para não ficar “martelando” (além da do nominatimSearch)
    await sleep(1500, "pausa entre chamadas");

    // 1) ViaCEP (se tiver CEP válido)
    if (cep && cep.replace(/\D/g, "").length === 8) {
      const cepLimpo = cep.replace(/\D/g, "");
      console.log(`📮 Consultando ViaCEP: ${cepLimpo}`);

      const via = await viaCepGet(cepLimpo);

      if (via?.data && !via.data.erro) {
        const logradouro = via.data.logradouro || "";
        const bairro = via.data.bairro || "";
        const cidade = via.data.localidade || "";
        const estado = via.data.uf || "";

        const enderecoViaCep = `${logradouro}, ${bairro}, ${cidade}, ${estado}, Brasil`
          .replace(/\s+/g, " ")
          .replace(/,\s*,/g, ",")
          .trim();

        console.log(`🏠 Endereço normalizado: ${enderecoViaCep}`);

        // 2) Google (opcional)
        if (GOOGLE_KEY) {
          console.log("🧭 Tentando Google Geocoding");
          const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            enderecoViaCep
          )}&key=${GOOGLE_KEY}`;

          const gRes = await axios.get(gUrl, { timeout: 30000 });

          if (gRes.data?.results?.length > 0) {
            console.log("✅ Google retornou coordenadas");
            const loc = gRes.data.results[0].geometry.location;
            return { lat: loc.lat, lng: loc.lng };
          }
        }

        // 3) Nominatim usando o endereço do ViaCEP
        const nRes = await nominatimSearch(enderecoViaCep);

        if (nRes?.data?.length > 0) {
          console.log("📍 Coordenadas obtidas via Nominatim");
          return {
            lat: parseFloat(nRes.data[0].lat),
            lng: parseFloat(nRes.data[0].lon),
          };
        }
      }
    }

    // 4) Fallback: texto original
    if (!endereco || endereco.trim().length < 8) {
      console.log("⚠️ Endereço muito curto, ignorando");
      return null;
    }

    await sleep(1500, "pausa antes do fallback");
    console.log(`📝 Geocoding fallback: ${endereco}`);

    const fRes = await nominatimSearch(endereco);

    if (fRes?.data?.length > 0) {
      console.log("📍 Coordenadas obtidas via fallback");
      return {
        lat: parseFloat(fRes.data[0].lat),
        lng: parseFloat(fRes.data[0].lon),
      };
    }

    console.log("❌ Nenhuma coordenada encontrada");
    return null;
  } catch (err) {
    console.error("🔥 Erro no geocode:", {
      message: err?.message,
      code: err?.code,
      syscall: err?.syscall,
      hostname: err?.hostname,
      address: err?.address,
      port: err?.port,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    return null;
  }
}
