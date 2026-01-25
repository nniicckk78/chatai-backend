#!/usr/bin/env python3
"""
Einfacher OpenAI-kompatibler API-Server für LoRA-Adapter
Lädt das Basis-Modell mit CPU-Offloading und den LoRA-Adapter mit PEFT
"""

import os
import sys
from pathlib import Path
from typing import List, Optional
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel, PeftConfig

# ===== KONFIGURATION =====
BASE_MODEL_PATH = os.path.expanduser("~/Desktop/models/llama-3.1-8b-instruct")
LORA_ADAPTER_PATH = os.path.expanduser("~/Desktop/models/chatmod_lora")
OFFLOAD_FOLDER = os.path.expanduser("~/Desktop/models/offload")
MODEL_NAME = "chatmod-lora"  # Name, der in /v1/models zurückgegeben wird
PORT = 8000

# ===== GLOBALE VARIABLEN =====
app = FastAPI(title="LoRA API Server")
tokenizer = None
model = None

# CORS aktivieren
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== PYDANTIC MODELS =====
class Message(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[Message]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 512
    stream: Optional[bool] = False

class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = 1769270732
    owned_by: str = "owner"

class ModelsResponse(BaseModel):
    object: str = "list"
    data: List[ModelInfo]

# ===== MODELL LADEN =====
def load_model_with_lora():
    """Lädt das Basis-Modell mit CPU-Offloading und den LoRA-Adapter"""
    global tokenizer, model
    
    print("🔄 Lade Tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    
    print("🔄 Lade Basis-Modell mit bfloat16 (weniger Speicher)...")
    # KRITISCH: bfloat16 braucht halb so viel Speicher wie float32
    # Versuche bfloat16, falls nicht verfügbar: float16
    try:
        dtype = torch.bfloat16
        print("ℹ️  Verwende bfloat16 (halber Speicher)")
    except:
        dtype = torch.float16
        print("ℹ️  Verwende float16 (halber Speicher)")
    
    # WICHTIG: Lade OHNE device_map, damit Modellstruktur erhalten bleibt
    # für LoRA-Adapter. Mit bfloat16 sollte es in 16GB RAM passen.
    print("⚠️  WARNUNG: Modell wird vollständig in RAM geladen!")
    print("⚠️  Mit bfloat16 sollte es funktionieren, aber Speicher ist knapp.")
    
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_PATH,
        torch_dtype=dtype,  # bfloat16 statt float32 (halb so viel Speicher)
        low_cpu_mem_usage=True,
        device_map=None,  # KEIN device_map, damit Struktur erhalten bleibt
    )
    
    # Verschiebe auf CPU
    model = model.to("cpu")
    
    print("🔄 Lade LoRA-Adapter...")
    # LoRA-Adapter OHNE device_map (Modellstruktur muss erhalten bleiben)
    model = PeftModel.from_pretrained(model, LORA_ADAPTER_PATH)
    model = model.to("cpu")
    model.eval()  # Evaluation-Modus
    
    print("✅ Modell erfolgreich geladen!")
    print("ℹ️  Modell läuft vollständig auf CPU-RAM")
    print("ℹ️  Erste Anfrage kann 30-60 Sekunden dauern")
    return model

# ===== API ENDPOINTS =====
@app.get("/v1/models")
async def list_models():
    """Gibt verfügbare Modelle zurück (OpenAI-kompatibel)"""
    return {
        "object": "list",
        "data": [{
            "id": MODEL_NAME,
            "object": "model",
            "created": 1769270732,
            "owned_by": "owner"
        }]
    }

@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """Generiert Chat-Completions (OpenAI-kompatibel)"""
    global tokenizer, model
    
    print(f"📨 NEUE ANFRAGE erhalten: Modell={request.model}, Messages={len(request.messages)}, max_tokens={request.max_tokens}")
    print(f"📨 System-Message: {request.messages[0].content[:100] if request.messages and request.messages[0].role == 'system' else 'Keine'}...")
    print(f"📨 User-Message: {request.messages[-1].content[:100] if request.messages else 'Keine'}...")
    
    if model is None or tokenizer is None:
        print("❌ FEHLER: Modell nicht geladen!")
        raise HTTPException(status_code=503, detail="Modell nicht geladen")
    
    try:
        print("🔄 Starte Generierung...")
        # Konvertiere Messages in Prompt-Format für Llama
        prompt = format_messages_for_llama(request.messages)
        
        # Tokenisiere
        inputs = tokenizer(prompt, return_tensors="pt")
        
        # Verschiebe Inputs auf CPU (Modell läuft auf CPU)
        # Prüfe ob Modell auf CPU oder verteilt ist
        try:
            device = next(model.parameters()).device
        except:
            device = torch.device("cpu")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        
        # Generiere
        print(f"🔄 Tokenisiere Prompt... ({inputs['input_ids'].shape[1]} Tokens)")
        print(f"🔄 Starte Modell-Generierung (max_new_tokens={request.max_tokens or 512})...")
        print(f"⚠️  Dies kann 30-120 Sekunden dauern auf CPU...")
        
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=min(request.max_tokens or 512, 200),  # 🚨 REDUZIERT: Max 200 Tokens (schneller)
                temperature=request.temperature or 0.7,
                do_sample=True,
                pad_token_id=tokenizer.eos_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
        
        print(f"✅ Modell-Generierung abgeschlossen! ({len(outputs[0])} Tokens generiert)")
        
        # Dekodiere Antwort
        generated_text = tokenizer.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        
        print(f"✅ Generierung abgeschlossen: {len(generated_text)} Zeichen generiert")
        print(f"✅ Antwort (erste 200 Zeichen): {generated_text[:200]}...")
        
        # OpenAI-kompatibles Format
        return {
            "id": "chatcmpl-" + os.urandom(16).hex(),
            "object": "chat.completion",
            "created": 1769270732,
            "model": MODEL_NAME,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": generated_text.strip()
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": inputs["input_ids"].shape[1],
                "completion_tokens": len(outputs[0]) - inputs["input_ids"].shape[1],
                "total_tokens": len(outputs[0])
            }
        }
    
    except Exception as e:
        print(f"❌ Fehler bei Generierung: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health():
    """Health-Check Endpoint"""
    return {"status": "ok", "model_loaded": model is not None}

def format_messages_for_llama(messages: List[Message]) -> str:
    """Formatiert Messages für Llama 3.1 Format"""
    formatted = ""
    for msg in messages:
        if msg.role == "system":
            formatted += f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{msg.content}<|eot_id|>\n"
        elif msg.role == "user":
            formatted += f"<|start_header_id|>user<|end_header_id|>\n\n{msg.content}<|eot_id|>\n"
        elif msg.role == "assistant":
            formatted += f"<|start_header_id|>assistant<|end_header_id|>\n\n{msg.content}<|eot_id|>\n"
    
    formatted += "<|start_header_id|>assistant<|end_header_id|>\n\n"
    return formatted

# ===== STARTUP =====
@app.on_event("startup")
async def startup():
    """Lädt Modell beim Server-Start"""
    print("🚀 Starte LoRA API Server...")
    print(f"📁 Basis-Modell: {BASE_MODEL_PATH}")
    print(f"📁 LoRA-Adapter: {LORA_ADAPTER_PATH}")
    print(f"📁 Offload-Ordner: {OFFLOAD_FOLDER}")
    
    # Prüfe ob Pfade existieren
    if not Path(BASE_MODEL_PATH).exists():
        print(f"❌ FEHLER: Basis-Modell nicht gefunden: {BASE_MODEL_PATH}")
        sys.exit(1)
    
    if not Path(LORA_ADAPTER_PATH).exists():
        print(f"❌ FEHLER: LoRA-Adapter nicht gefunden: {LORA_ADAPTER_PATH}")
        sys.exit(1)
    
    # Erstelle Offload-Ordner falls nicht vorhanden
    Path(OFFLOAD_FOLDER).mkdir(parents=True, exist_ok=True)
    
    # Lade Modell
    try:
        load_model_with_lora()
    except Exception as e:
        print(f"❌ FEHLER beim Laden des Modells: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

# ===== MAIN =====
if __name__ == "__main__":
    print(f"🌐 Server startet auf http://0.0.0.0:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
