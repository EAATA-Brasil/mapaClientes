import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;

export default async function geocode(endereco, cep) {
  try {
    // 1. TENTAR BUSCAR CEP NO VIACEP (MUITO PRECISO)
    if (cep && cep.replace(/\D/g, "").length === 8) {
      const cepLimpo = cep.replace(/\D/g, "");
      const viaCepUrl = `https://viacep.com.br/ws/${cepLimpo}/json/`;

      const via = await axios.get(viaCepUrl);

      if (!via.data.erro) {
        const logradouro = via.data.logradouro || "";
        const bairro = via.data.bairro || "";
        const cidade = via.data.localidade || "";
        const estado = via.data.uf || "SP";

        // Endereço DO BRASIL altamente preciso
        const enderecoViaCep = `${logradouro}, ${bairro}, ${cidade}, ${estado}, Brasil`;

        // 2. GEOCODING PRECISO COM GOOGLE
        if (GOOGLE_KEY) {
          const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoViaCep)}&key=${GOOGLE_KEY}`;
          const gRes = await axios.get(gUrl);

          if (gRes.data.results.length > 0) {
            const loc = gRes.data.results[0].geometry.location;
            return { lat: loc.lat, lng: loc.lng };
          }
        }

        // 3. FALLBACK → Nominatim
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(enderecoViaCep)}&limit=1`;

        const nRes = await axios.get(nominatimUrl, {
          headers: { "User-Agent": "EAATA-Mapa/1.0" }
        });

        if (nRes.data.length > 0) {
          return {
            lat: parseFloat(nRes.data[0].lat),
            lng: parseFloat(nRes.data[0].lon)
          };
        }
      }
    }

    // 4. SE CHEGAR AQUI → GEOCODING PELO TEXTO ORIGINAL
    const fallback = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco)}&limit=1`;
    const fRes = await axios.get(fallback, {
      headers: { "User-Agent": "EAATA-Mapa/1.0" }
    });

    if (fRes.data.length > 0) {
      return {
        lat: parseFloat(fRes.data[0].lat),
        lng: parseFloat(fRes.data[0].lon)
      };
    }

    return null;
  } catch (err) {
    console.error("Erro no geocode:", err);
    return null;
  }
}
