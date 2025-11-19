import os
from typing import TypedDict, List, Dict, Optional, Any

from pinecone import Pinecone, ServerlessSpec
from PyPDF2 import PdfReader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from openai import OpenAI
from langgraph.graph import StateGraph, END

# Config
pinecone_key = "pcsk_1234"
pinecone_index = "pdf-qa-index"
openAi_key = "sk-1234"

pdf_path= 'RAG_Failure_Modes_and_Fallbacks_CheatSheet.pdf'
query = "What are the main RAG failure modes?"  # this can be fetched from terminal also 


# Initialize clients
if not pinecone_key or not openAi_key:
    raise ValueError("Set pinecone_key and openAi_key variables")

openai_client = OpenAI(api_key=openAi_key)
pc = Pinecone(api_key=pinecone_key)

# Get or create Pinecone index
existing_indexes = [idx.name for idx in pc.list_indexes()]
if pinecone_index not in existing_indexes:
    pc.create_index(
        name=pinecone_index,
        dimension=768,
        metric="cosine",
        spec=ServerlessSpec(cloud="aws", region="us-east-1")
    )

pinecone_index = pc.Index(pinecone_index)

def index_pdf(pdf_path: str, chunk_size: int = 800, chunk_overlap: int = 150) -> int:
    """Extract text from PDF, chunk it, create embeddings, and store in Pinecone"""
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    
    # Extract text from PDF
    reader = PdfReader(pdf_path)
    text = "\n".join([page.extract_text() or "" for page in reader.pages])
    
    if not text.strip():
        raise ValueError("No text extracted from PDF")
    
    # Split into chunks
    splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    chunks = splitter.split_text(text)
    print(f"Created {len(chunks)} chunks from PDF")
    
    # Create embeddings and prepare vectors
    vectors = []
    batch_size = 100
    
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        embeds = openai_client.embeddings.create(
            model="text-embedding-3-large",
            input=batch
        )
        
        for j, embed_data in enumerate(embeds.data):
            vectors.append({
                "id": f"doc-{i + j}",
                "values": embed_data.embedding,
                "metadata": {"text": batch[j]}
            })
    
    # inserting the data to Pinecone
    for i in range(0, len(vectors), 100):
        pinecone_index.upsert(vectors=vectors[i:i + 100])
    
    print(f"Indexed {len(vectors)} chunks to Pinecone")
    return len(vectors)

def pinecone_retrieve(query: str, k: int = 4) -> str:
    """Retrieve relevant chunks from Pinecone based on semantic similarity"""
    if not query:
        return ""
    
    # Embeddings creation
    query_embed = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=query
    )
    
    # Query
    results = pinecone_index.query(
        vector=query_embed.data[0].embedding,
        top_k=k,
        include_metadata=True
    )
    
    # Extract text from results
    chunks = [match.get("metadata", {}).get("text", "") for match in results.get("matches", [])]
    return "\n\n".join([c for c in chunks if c])

class State(TypedDict):
    messages: List[Dict[str, str]]
    chain_of_thought: List[str]
    tools: Dict[str, Any]

def react_agent_node(state: State) -> State:
    """ReAct agent - retrieves context and generates answer"""
    query = state["messages"][-1]["content"]
    state["chain_of_thought"] = state.get("chain_of_thought", [])
    
    # Retrieve context from Pinecone
    retrieve_fn = state.get("tools", {}).get("retrieve")
    if retrieve_fn:
        context = retrieve_fn(query)
        state["chain_of_thought"].append(f"Retrieved {len(context)} chars of context")
    else:
        context = ""
        state["chain_of_thought"].append("No retrieval tool available")
    
    prompt = f"""Question: {query}

Context from PDF:
{context if context else 'No context available'}

Based on the context above, provide a clear and concise answer. If the context doesn't contain relevant information, say so."""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",  # Using gpt-4o-mini (cheaper and you have access)
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7
    )
    
    answer = response.choices[0].message.content
    state["chain_of_thought"].append(f"Generated answer ({len(answer)} chars)")
    state["messages"].append({"role": "assistant", "content": answer})
    
    return state

# Build LangGraph workflow
graph = StateGraph(State)
graph.add_node("react_agent", react_agent_node)
graph.set_entry_point("react_agent")
graph.add_edge("react_agent", END)
app = graph.compile()

if __name__ == "__main__":
    """
    USAGE:
    1. First time: Index your PDF
       - Place your PDF in this directory (e.g., 'document.pdf')
       - Uncomment the index_pdf line below and run once
    
    2. After indexing: Query your PDF
       - Just run the script with your question
    """
    
    state = {
        "messages": [{"role": "user", "content": query}],
        "chain_of_thought": [],
        "tools": {"retrieve": pinecone_retrieve}
    }
    
    result = app.invoke(state)
    
    print("\n" + "="*20)
    print("ANSWER")
    print("="*20)
    print(result["messages"][-1]["content"])
    
    print("\n" + "="*20)
    print("DEBUG INFO")
    print("="*20)
    for step in result["chain_of_thought"]:
        print(f"• {step}")

