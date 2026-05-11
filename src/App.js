import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, serverTimestamp, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';

// 1. VARIABLES DE ENTORNO Y CONFIGURACIÓN
const isCanvas = typeof __firebase_config !== 'undefined';
const canvasAppId = typeof __app_id !== 'undefined' ? __app_id : 'lector-hechizado';

let firebaseConfig = {};

// Configuración estricta para Create React App (Webpack evalúa esto en tiempo de compilación)
if (isCanvas) {
  firebaseConfig = JSON.parse(__firebase_config);
} else {
  firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY || "demo",
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || "demo",
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || "demo",
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || "demo",
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || "demo",
    appId: process.env.REACT_APP_FIREBASE_APP_ID || "demo"
  };
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();

// Funciones para referencias a Firebase
const getItemsRef = (uid) => {
  if (isCanvas) {
    const safeAppId = String(canvasAppId).replace(/\//g, '_'); 
    return collection(db, 'artifacts', safeAppId, 'users', uid, 'books');
  }
  return collection(db, 'users', uid, 'books');
};

const getItemDocRef = (uid, itemId) => {
  if (isCanvas) {
    const safeAppId = String(canvasAppId).replace(/\//g, '_'); 
    return doc(db, 'artifacts', safeAppId, 'users', uid, 'books', itemId);
  }
  return doc(db, 'users', uid, 'books', itemId);
};

const getStorageFileRef = (uid, fileName) => {
  if (isCanvas) {
    const safeAppId = String(canvasAppId).replace(/\//g, '_');
    return ref(storage, `artifacts/${safeAppId}/users/${uid}/books/${Date.now()}_${fileName}`);
  }
  return ref(storage, `users/${uid}/books/${Date.now()}_${fileName}`);
};

export default function App() {
  // ESTADOS PRINCIPALES
  const [user, setUser] = useState(null);
  const [allItems, setAllItems] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [currentTab, setCurrentTab] = useState('reading');
  
  // ESTADOS DE CARGA
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [systemMessage, setSystemMessage] = useState("");
  
  // ESTADOS DE MODALES
  const [modalState, setModalState] = useState({ isOpen: false, type: '', item: null, inputValue: '' });
  const [inlineFolderInput, setInlineFolderInput] = useState("");
  
  // ESTADOS DEL VISOR DE LECTURA
  const [readingBook, setReadingBook] = useState(null);
  const [pdfInstance, setPdfInstance] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [scaleMode, setScaleMode] = useState('auto'); // auto, width, height, manual
  const [customScale, setCustomScale] = useState(1.2); // Para el zoom manual (+ y -)
  const [readerBrightness, setReaderBrightness] = useState(100);
  const [showFinishModal, setShowFinishModal] = useState(false);
  
  const canvasRef = useRef(null);
  const viewerContainerRef = useRef(null);

  // Cargar motores
  useEffect(() => {
    const loadScript = (src) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      if (src.includes('pdf.min.js')) {
        script.onload = () => window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      }
      document.body.appendChild(script);
    };
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js');
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
    // Carga segura del motor UNRAR
    loadScript('https://cdn.jsdelivr.net/npm/unrar-js@0.2.1/dist/unrar.js');
  }, []);

  // Autenticación
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Cargar biblioteca
  useEffect(() => {
    if (!user) return setAllItems([]);
    const itemsRef = getItemsRef(user.uid);
    const unsubscribe = onSnapshot(query(itemsRef), (snapshot) => {
      const loaded = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      loaded.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return (a.title || '').localeCompare(b.title || '');
      });
      setAllItems(loaded);
    });
    return () => unsubscribe();
  }, [user]);

  // NAVEGACIÓN POR TECLADO EN EL VISOR
  useEffect(() => {
    if (!readingBook || showFinishModal) return;

    const handleKeyDown = (e) => {
      if (isRendering) return;
      
      // Salir a la biblioteca principal
      if (e.key === 'Escape') {
        e.preventDefault();
        closeBook();
        return;
      }
      // Avanzar
      else if (['ArrowRight', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        changePage(1);
      } 
      // Retroceder
      else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        changePage(-1);
      }
      // Zoom IN
      else if (e.key === '+' || e.key === 'Add') {
        e.preventDefault();
        setScaleMode('manual');
        setCustomScale(prev => Math.min(prev + 0.2, 5.0));
      }
      // Zoom OUT
      else if (e.key === '-' || e.key === 'Subtract') {
        e.preventDefault();
        setScaleMode('manual');
        setCustomScale(prev => Math.max(prev - 0.2, 0.4));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readingBook, currentPage, totalPages, isRendering, showFinishModal]);

  const displayedItems = allItems.filter(item => {
    if ((item.parentId || null) !== currentFolder) return false;
    if (item.type === 'folder') return true;
    const status = item.status || 'reading';
    return status === currentTab;
  });

  const buildBreadcrumbs = () => {
    let path = [];
    let curr = currentFolder;
    while (curr) {
      const folder = allItems.find(i => i.id === curr);
      if (folder) {
        path.unshift(folder);
        curr = folder.parentId || null;
      } else break;
    }
    return path;
  };

  const mostrarMensaje = (texto) => {
    setSystemMessage(texto);
    setTimeout(() => setSystemMessage(""), 6000);
  };

  // ================= AUTENTICACIÓN Y DESCARGAS =================
  const handleLogin = async () => {
    try {
      if (isCanvas) {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token);
        else await signInAnonymously(auth);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (error) { mostrarMensaje("Las runas rechazan tu acceso."); }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setReadingBook(null);
    setCurrentFolder(null);
  };

  const handleDownload = async (book, e) => {
    e.stopPropagation();
    try {
      mostrarMensaje("Canalizando el pergamino a tu dispositivo...");
      const response = await fetch(book.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = book.title.toLowerCase().endsWith('.pdf') ? book.title : `${book.title}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      mostrarMensaje("¡Descarga completada con éxito! 📦");
    } catch (error) {
      mostrarMensaje("Fallo al materializar el documento.");
    }
  };

  // ================= GESTIÓN DE SUBIDA CON MINIATURA Y TRANSMUTACIÓN =================
  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    const targetInput = event.target;
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    
    if (!['pdf', 'cbz', 'cbr', 'txt', 'docx', 'doc'].includes(ext)) {
      mostrarMensaje("Formato no reconocido. Usa PDF, CBZ, CBR, TXT, DOC o DOCX.");
      targetInput.value = null; return;
    }

    setIsUploading(true); setUploadProgress(0);
    let fileToUpload = file;
    let fileName = file.name;

    // 1. Transmutar CBZ o CBR a PDF
    if (ext === 'cbz' || ext === 'cbr') {
      if (!window.jspdf || (!window.JSZip && ext === 'cbz')) {
        mostrarMensaje("Motores de alquimia apagados. Intenta en 5 segundos.");
        setIsUploading(false); targetInput.value = null; return;
      }
      
      // Control seguro si CBR no está disponible o falla su carga
      if (ext === 'cbr' && typeof window.unrar === 'undefined') {
        mostrarMensaje("⚠️ El motor UNRAR no se logró cargar correctamente. Por favor, convierte el archivo a .CBZ (ZIP) en tu computadora.");
        setIsUploading(false); targetInput.value = null; return;
      }

      mostrarMensaje(`Transmutando ${ext.toUpperCase()} a PDF (convirtiendo páginas a pergamino)...`);
      try {
        let imageNames = [];
        let zip;
        let unrarData;
        
        if (ext === 'cbz') {
          zip = await window.JSZip.loadAsync(file);
          imageNames = Object.keys(zip.files).filter(name => !zip.files[name].dir && name.match(/\.(jpe?g|png)$/i)).sort();
        } else if (ext === 'cbr') {
          const buffer = await file.arrayBuffer();
          const extractor = window.unrar.createExtractorFromData(new Uint8Array(buffer));
          const extracted = extractor.extractAll();
          unrarData = extracted[0].files.filter(f => !f.fileHeader.flags.directory && f.fileHeader.name.match(/\.(jpe?g|png)$/i));
          imageNames = unrarData.map(f => f.fileHeader.name).sort();
        }

        if (imageNames.length === 0) throw new Error("Tomo vacío");

        const { jsPDF } = window.jspdf;
        const pdfDoc = new jsPDF('p', 'mm', 'a4');
        const pageWidth = pdfDoc.internal.pageSize.getWidth();
        const pageHeight = pdfDoc.internal.pageSize.getHeight();

        for (let i = 0; i < imageNames.length; i++) {
          let imgData;
          if (ext === 'cbz') {
            imgData = await zip.files[imageNames[i]].async("base64");
          } else {
            const fileObj = unrarData.find(f => f.fileHeader.name === imageNames[i]);
            let binary = '';
            const bytes = fileObj.extract[1];
            const len = bytes.byteLength;
            for (let j = 0; j < len; j++) {
                binary += String.fromCharCode(bytes[j]);
            }
            imgData = window.btoa(binary);
          }

          const format = imageNames[i].toLowerCase().endsWith('png') ? 'PNG' : 'JPEG';
          if (i > 0) pdfDoc.addPage();
          pdfDoc.addImage(`data:image/${format.toLowerCase()};base64,${imgData}`, format, 0, 0, pageWidth, pageHeight, undefined, 'FAST');
          setUploadProgress(Math.floor(((i + 1) / imageNames.length) * 40)); 
        }
        fileToUpload = pdfDoc.output('blob');
        fileName = file.name.replace(new RegExp(`\\.${ext}$`, 'i'), '.pdf');
      } catch(e) {
        console.warn("Transmutación fallida:", e);
        mostrarMensaje(`Fallo en la transmutación del ${ext.toUpperCase()}. El grimorio podría ser demasiado pesado o tener un formato corrupto.`); 
        setIsUploading(false); targetInput.value = null; return;
      }
    }
    
    // 2. Transmutar TXT, DOCX y DOC a PDF
    if (ext === 'txt' || ext === 'docx' || ext === 'doc') {
      if (!window.jspdf || ((ext === 'docx' || ext === 'doc') && !window.mammoth)) {
        mostrarMensaje("Motores de alquimia apagados. Intenta en 5 segundos.");
        setIsUploading(false); targetInput.value = null; return;
      }
      mostrarMensaje(`Transmutando pergamino ${ext.toUpperCase()} a PDF...`);
      try {
        let textContent = "";
        
        if (ext === 'txt') {
          textContent = await file.text();
        } else if (ext === 'docx' || ext === 'doc') {
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.mammoth.extractRawText({ arrayBuffer });
          textContent = result.value || "El pergamino antiguo no pudo ser decodificado.";
        }

        const { jsPDF } = window.jspdf;
        const pdfDoc = new jsPDF('p', 'pt', 'a4');
        const margin = 40;
        const pdfWidth = pdfDoc.internal.pageSize.getWidth();
        const pdfHeight = pdfDoc.internal.pageSize.getHeight();
        
        const lines = pdfDoc.splitTextToSize(textContent, pdfWidth - margin * 2);
        let cursorY = margin;
        
        for(let i = 0; i < lines.length; i++) {
           if (cursorY > pdfHeight - margin) {
               pdfDoc.addPage();
               cursorY = margin;
           }
           pdfDoc.text(lines[i], margin, cursorY);
           cursorY += 14; 
           setUploadProgress(Math.floor((i / lines.length) * 40));
        }
        
        fileToUpload = pdfDoc.output('blob');
        const replaceExt = new RegExp(`\\.${ext}$`, 'i');
        fileName = file.name.replace(replaceExt, '.pdf');
      } catch(e) {
        mostrarMensaje("Fallo al escribir las runas de texto."); setIsUploading(false); targetInput.value = null; return;
      }
    }

    // Generar Miniatura (Portada)
    let thumbBlob = null;
    try {
      mostrarMensaje("Extrayendo la portada para el archivo...");
      const url = URL.createObjectURL(fileToUpload);
      const pdf = await window.pdfjsLib.getDocument(url).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.5 });
      
      // Mejorar también la miniatura para pantallas retina
      const outputScale = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      
      await page.render({ 
        canvasContext: canvas.getContext('2d'), 
        transform: transform, 
        viewport: viewport 
      }).promise;
      
      thumbBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      URL.revokeObjectURL(url);
    } catch(e) { console.error("Sin miniatura", e); }

    // Proceso de Subida Final
    const storagePath = `users/${user.uid}/books/${Date.now()}_${fileName}`;
    const storageRef = getStorageFileRef(user.uid, fileName);

    if (isCanvas) {
      let prog = (ext !== 'pdf') ? 40 : 0;
      const interval = setInterval(() => {
        prog += 10; setUploadProgress(prog);
        if (prog >= 100) {
          clearInterval(interval);
          const fakeUrl = URL.createObjectURL(fileToUpload);
          const fakeThumb = thumbBlob ? URL.createObjectURL(thumbBlob) : null;
          addDoc(getItemsRef(user.uid), {
            title: fileName, url: fakeUrl, type: 'pdf', parentId: currentFolder, storagePath,
            thumbnailUrl: fakeThumb, thumbStoragePath: null, createdAt: serverTimestamp(),
            size: (fileToUpload.size / 1024 / 1024).toFixed(2) + ' MB', currentPage: 1, status: 'reading'
          }).then(() => { setIsUploading(false); mostrarMensaje("Grimorio almacenado."); targetInput.value = null; });
        }
      }, 400);
      return;
    }

    // Subida a Firebase Storage
    const uploadTask = uploadBytesResumable(storageRef, fileToUpload);
    uploadTask.on('state_changed',
      (snapshot) => {
        const base = (ext !== 'pdf') ? 40 : 0; 
        const multiplier = (ext !== 'pdf') ? 0.6 : 1;
        setUploadProgress((base + ((snapshot.bytesTransferred / snapshot.totalBytes) * 100 * multiplier)).toFixed(0));
      },
      () => { mostrarMensaje("La transferencia ha fallado."); setIsUploading(false); },
      async () => {
        try {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          
          let thumbDownloadURL = null;
          let thumbStoragePath = null;
          if (thumbBlob) {
            const thumbStorageRef = getStorageFileRef(user.uid, `thumb_${fileName}.jpg`);
            await uploadBytesResumable(thumbStorageRef, thumbBlob);
            thumbDownloadURL = await getDownloadURL(thumbStorageRef);
            thumbStoragePath = thumbStorageRef.fullPath;
          }

          await addDoc(getItemsRef(user.uid), {
            title: fileName, url: downloadURL, type: 'pdf', parentId: currentFolder,
            storagePath: storageRef.fullPath, thumbnailUrl: thumbDownloadURL, thumbStoragePath,
            createdAt: serverTimestamp(), size: (fileToUpload.size / 1024 / 1024).toFixed(2) + ' MB', currentPage: 1, status: 'reading'
          });

          setIsUploading(false); mostrarMensaje("Grimorio materializado con éxito."); targetInput.value = null;
        } catch (err) { mostrarMensaje("Fallo al registrar."); setIsUploading(false); }
      }
    );
  };

  // ================= ACCIONES DE ARCHIVO/CARPETA =================
  const handleCreateFolder = async () => {
    if (!modalState.inputValue.trim()) return;
    try {
      await addDoc(getItemsRef(user.uid), { title: modalState.inputValue.trim(), type: 'folder', parentId: currentFolder, createdAt: serverTimestamp() });
      closeModal(); mostrarMensaje("Cámara forjada.");
    } catch (e) { mostrarMensaje("Error al forjar la cámara."); }
  };

  const handleCreateInlineFolder = async () => {
    if (!inlineFolderInput.trim()) return;
    try {
      const newDoc = await addDoc(getItemsRef(user.uid), { title: inlineFolderInput.trim(), type: 'folder', parentId: currentFolder, createdAt: serverTimestamp() });
      setModalState({ ...modalState, inputValue: newDoc.id });
      setInlineFolderInput(""); mostrarMensaje("Cámara forjada y seleccionada.");
    } catch (e) { mostrarMensaje("Error al forjar la cámara."); }
  };

  const handleRename = async () => {
    if (!modalState.inputValue.trim() || !modalState.item) return;
    try {
      await updateDoc(getItemDocRef(user.uid, modalState.item.id), { title: modalState.inputValue.trim() });
      closeModal(); mostrarMensaje("Nombre grabado en las runas.");
    } catch (e) { mostrarMensaje("Error al cambiar nombre."); }
  };

  const handleMove = async () => {
    if (!modalState.item) return;
    const targetFolder = modalState.inputValue === 'root' ? null : modalState.inputValue;
    
    if (modalState.item.type === 'folder' && targetFolder === modalState.item.id) {
      mostrarMensaje("Paradoja evitada: No puedes introducir una cámara dentro de sí misma.");
      return;
    }

    try {
      await updateDoc(getItemDocRef(user.uid, modalState.item.id), { parentId: targetFolder });
      closeModal(); mostrarMensaje("Materia desplazada a través del éter.");
    } catch (e) { mostrarMensaje("Error en teletransportación."); }
  };

  const handleDelete = async () => {
    if (!modalState.item) return;
    const item = modalState.item;
    try {
      if (item.type === 'folder' && allItems.some(i => i.parentId === item.id)) {
        return mostrarMensaje("La cámara debe estar vacía para demolerla.");
      }
      await deleteDoc(getItemDocRef(user.uid, item.id));
      if (item.type !== 'folder' && !isCanvas) {
        if (item.storagePath) await deleteObject(ref(storage, item.storagePath)).catch(()=>null);
        if (item.thumbStoragePath) await deleteObject(ref(storage, item.thumbStoragePath)).catch(()=>null);
      }
      closeModal(); mostrarMensaje("Materia reducida a cenizas.");
    } catch (e) { mostrarMensaje("Fallo en la aniquilación."); }
  };

  const handleFinishBook = async () => {
    try {
      await updateDoc(getItemDocRef(user.uid, readingBook.id), { status: 'finished', currentPage: totalPages });
      setShowFinishModal(false);
      closeBook();
      mostrarMensaje("Tomo sellado con éxito.");
    } catch (e) {
      mostrarMensaje("Fallo al sellar el documento.");
    }
  };

  const closeModal = () => {
    setModalState({ isOpen: false, type: '', item: null, inputValue: '' });
    setInlineFolderInput("");
  };

  // ================= SISTEMA DE LECTURA IN-APP =================
  const openBook = async (book) => {
    setReadingBook(book); 
    setCurrentPage(book.currentPage || 1); 
    setTotalPages(0);
    setPdfInstance(null); 
    setScaleMode('auto'); 
    setCustomScale(1.2);
    setReaderBrightness(100);
    setShowFinishModal(false);
    
    if (window.pdfjsLib) {
      const loadingTask = window.pdfjsLib.getDocument(book.url);
      loadingTask.promise.then(pdf => {
        setPdfInstance(pdf); setTotalPages(pdf.numPages);
      }).catch(() => { mostrarMensaje("Los sellos del pergamino están corruptos."); setReadingBook(null); });
    } else { mostrarMensaje("Motores apagados. Intenta de nuevo."); setReadingBook(null); }
  };

  // EFECTO PRINCIPAL DE RENDERIZADO DEL PDF (AHORA CON ALTA RESOLUCIÓN)
  useEffect(() => {
    if (pdfInstance && readingBook && canvasRef.current && viewerContainerRef.current) {
      setIsRendering(true);
      pdfInstance.getPage(currentPage).then(page => {
        const baseViewport = page.getViewport({ scale: 1.0 });
        let newScale = 1.2;
        const container = viewerContainerRef.current;
        
        if (scaleMode === 'width') newScale = (container.clientWidth - 40) / baseViewport.width;
        else if (scaleMode === 'height') newScale = (container.clientHeight - 40) / baseViewport.height;
        else if (scaleMode === 'manual') newScale = customScale;

        const viewport = page.getViewport({ scale: newScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        
        // Magia para resoluciones Retina / Móviles (Alta Densidad de Píxeles)
        const outputScale = window.devicePixelRatio || 1;
        
        // Multiplicamos la resolución interna del canvas
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        
        // Mantenemos el tamaño físico en pantalla mediante CSS
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";

        // Aplicamos la transformación matemática para escalar el contexto
        const transform = outputScale !== 1 
          ? [outputScale, 0, 0, outputScale, 0, 0] 
          : null;

        const renderContext = {
          canvasContext: context,
          transform: transform,
          viewport: viewport
        };

        page.render(renderContext).promise.then(() => setIsRendering(false)).catch(() => setIsRendering(false));
      });
    }
  }, [pdfInstance, currentPage, readingBook, scaleMode, customScale]);

  const changePage = async (delta) => {
    if (isRendering) return;
    const newPage = currentPage + delta;
    
    if (newPage > totalPages) {
      setShowFinishModal(true);
      return;
    }

    if (newPage > 0 && newPage <= totalPages) {
      setCurrentPage(newPage);
      try { await updateDoc(getItemDocRef(user.uid, readingBook.id), { currentPage: newPage }); } catch (e) {}
    }
  };

  const closeBook = () => { setReadingBook(null); setPdfInstance(null); setShowFinishModal(false); };

  // ================= RENDERIZADO DE INTERFAZ =================
  if (!user) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-4 text-red-100 font-serif relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-red-950 via-red-800 to-red-950"></div>
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-red-900 via-neutral-950 to-neutral-950"></div>
        <div className="max-w-md w-full bg-neutral-900 rounded shadow-[0_0_40px_rgba(150,0,0,0.15)] p-10 text-center border-t-2 border-b-2 border-red-900 relative z-10">
          <div className="text-6xl mb-6 text-amber-600 drop-shadow-[0_0_15px_rgba(217,119,6,0.4)]">⚙️📜</div>
          <h1 className="text-4xl font-bold text-red-600 mb-2 tracking-wider uppercase">Lector Hechizado</h1>
          <p className="text-neutral-400 mb-10 italic">Archivos Mecánicos del Saber Oculto</p>
          <button onClick={handleLogin} className="w-full flex items-center justify-center gap-3 bg-red-950 text-red-100 border border-red-800 font-bold py-3 px-6 rounded hover:bg-red-900 transition uppercase tracking-widest">
            Sellar Pacto (Login)
          </button>
        </div>
      </div>
    );
  }

  if (readingBook) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-start text-red-100 font-serif overflow-hidden fixed inset-0 z-40">
        
        {/* Barra Superior - Controles */}
        <div className="w-full bg-neutral-900 p-3 shadow-lg flex flex-wrap justify-between items-center border-b border-red-900 z-20 shrink-0 gap-2">
          <button onClick={closeBook} className="text-red-500 hover:text-red-400 px-3 py-1 font-bold transition uppercase tracking-wider text-xs sm:text-sm border border-transparent hover:border-red-900 rounded z-30">
            ⟵ Archivos
          </button>
          
          <div className="flex gap-2 items-center z-30">
            {/* Control de Brillo */}
            <div className="hidden sm:flex items-center gap-1 bg-neutral-950 px-2 border border-neutral-800 rounded" title="Ajuste de Luz del Lector">
              <span className="text-xs text-neutral-500">🔅</span>
              <input type="range" min="30" max="100" value={readerBrightness} onChange={e => setReaderBrightness(e.target.value)} className="w-16 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-red-600" />
              <span className="text-xs text-amber-500">☀️</span>
            </div>

            {/* Controles de Escala y Zoom */}
            <button onClick={() => setScaleMode('width')} className={`px-2 py-1 text-xs border ${scaleMode === 'width' ? 'bg-red-900 border-red-700 text-white' : 'border-neutral-700 text-neutral-400 hover:border-red-900'}`}>[↔]</button>
            <button onClick={() => setScaleMode('height')} className={`px-2 py-1 text-xs border ${scaleMode === 'height' ? 'bg-red-900 border-red-700 text-white' : 'border-neutral-700 text-neutral-400 hover:border-red-900'}`}>[↕]</button>
            <button onClick={() => setScaleMode('auto')} className={`px-2 py-1 text-xs border ${scaleMode === 'auto' ? 'bg-red-900 border-red-700 text-white' : 'border-neutral-700 text-neutral-400 hover:border-red-900'}`}>[Auto]</button>
            <div className="flex gap-1 ml-2 pl-2 border-l border-neutral-800">
               <button onClick={() => { setScaleMode('manual'); setCustomScale(p => Math.max(p - 0.2, 0.4)); }} className="px-2 py-1 text-xs border border-neutral-700 text-neutral-400 hover:border-red-900">[-]</button>
               <button onClick={() => { setScaleMode('manual'); setCustomScale(p => Math.min(p + 0.2, 5.0)); }} className="px-2 py-1 text-xs border border-neutral-700 text-neutral-400 hover:border-red-900">[+]</button>
            </div>
          </div>

          <div className="text-sm font-mono text-amber-600 font-bold bg-neutral-950 px-3 py-1 rounded border border-neutral-800 z-30">
            {totalPages > 0 ? `Pág. ${currentPage} / ${totalPages}` : 'Cargando...'}
          </div>
        </div>

        {/* CONTENEDOR DEL VISOR Y BARRA DE PROGRESO */}
        <div className="flex-grow w-full overflow-hidden flex flex-col relative">
          
          <div className="flex-grow w-full overflow-auto flex justify-center items-center bg-[#0d0d0d] p-4 relative" ref={viewerContainerRef}>
            {/* Zonas táctiles de avance/retroceso */}
            <div className="absolute inset-y-0 left-0 w-1/4 z-10 cursor-w-resize" onClick={() => changePage(-1)} title="Página Anterior"></div>
            <div className="absolute inset-y-0 right-0 w-1/4 z-10 cursor-e-resize" onClick={() => changePage(1)} title="Página Siguiente"></div>

            {!pdfInstance && (
              <div className="absolute inset-0 flex items-center justify-center text-red-800 animate-pulse font-bold tracking-widest uppercase">
                Alineando engranajes... ⚙️
              </div>
            )}
            
            <canvas 
              ref={canvasRef} 
              className="shadow-[0_0_30px_rgba(0,0,0,0.8)] bg-white transition-all duration-200 z-0"
              style={{ display: pdfInstance ? 'block' : 'none', filter: `brightness(${readerBrightness}%)` }}
            ></canvas>
          </div>

          {/* Barra de progreso inferior */}
          <div className="w-full bg-neutral-900 h-1.5 z-20">
            <div className="bg-red-600 h-full transition-all duration-300 shadow-[0_0_10px_rgba(220,38,38,1)]" style={{ width: `${totalPages > 0 ? (currentPage / totalPages) * 100 : 0}%` }}></div>
          </div>
        </div>

        {/* MODAL DE FIN DE LECTURA */}
        {showFinishModal && (
          <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
            <div className="bg-neutral-900 border-2 border-red-900 p-8 w-full max-w-md shadow-[0_0_50px_rgba(150,0,0,0.4)] text-center relative z-50">
              <div className="text-5xl mb-4 text-amber-600">📜🔒</div>
              <h3 className="text-2xl font-bold text-red-500 mb-4 uppercase tracking-widest border-b border-red-900/50 pb-4">
                El Tomo ha concluido
              </h3>
              <p className="text-red-100 mb-8 italic">
                Has alcanzado la última página de esta historia. ¿Deseas sellar este grimorio y enviarlo a las profundidades de las Lecturas Finalizadas?
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => setShowFinishModal(false)}
                  className="px-6 py-2 text-sm text-neutral-400 hover:text-white border border-transparent hover:border-neutral-700 transition uppercase"
                >
                  No, aún no
                </button>
                <button
                  onClick={handleFinishBook}
                  className="px-6 py-2 text-sm font-bold transition uppercase border bg-red-950 text-red-500 border-red-800 hover:bg-red-900 hover:text-white"
                >
                  Sellar Tomo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-red-100 font-serif pb-10">
      
      {systemMessage && (
        <div className="fixed top-4 right-4 bg-red-900 border border-red-500 text-white px-6 py-3 shadow-[0_0_15px_rgba(220,38,38,0.5)] z-50 animate-bounce font-bold tracking-wide">
          {systemMessage}
        </div>
      )}

      <nav className="bg-neutral-900 shadow-md border-b-2 border-red-900 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl text-amber-600">⚙️</span>
            <h1 className="text-xl font-bold text-red-600 tracking-widest uppercase">Lector Hechizado</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-neutral-400 italic hidden sm:block">Archivista en turno</span>
            <button onClick={handleLogout} className="text-xs uppercase tracking-widest border border-red-900 text-red-500 hover:bg-red-950 hover:text-red-400 px-3 py-1 transition">
              Cerrar Cámara
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 mt-8">

        {/* Pestañas (Tabs) Activos vs Finalizados */}
        <div className="flex gap-4 mb-6 border-b border-neutral-800 overflow-x-auto">
           <button onClick={() => setCurrentTab('reading')} className={`pb-2 px-4 uppercase font-bold tracking-widest text-sm transition whitespace-nowrap ${currentTab === 'reading' ? 'text-amber-500 border-b-2 border-amber-500' : 'text-neutral-500 hover:text-red-400'}`}>
             Lecturas Activas
           </button>
           <button onClick={() => setCurrentTab('finished')} className={`pb-2 px-4 uppercase font-bold tracking-widest text-sm transition whitespace-nowrap ${currentTab === 'finished' ? 'text-red-500 border-b-2 border-red-500' : 'text-neutral-500 hover:text-red-400'}`}>
             Tomos Sellados
           </button>
        </div>

        <div className="bg-neutral-900 p-6 shadow-[0_0_20px_rgba(0,0,0,0.5)] border border-neutral-800 mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 relative overflow-hidden">
          <div className="absolute -right-6 -top-6 text-6xl opacity-5 text-amber-600 rotate-45">⚙️</div>
          <div className="z-10">
            <h2 className="text-2xl font-bold text-red-500 tracking-wide">
              {currentFolder ? 'Cámara Profunda' : 'Archivo Principal'}
            </h2>
            <div className="flex items-center gap-2 mt-2 text-sm text-neutral-400">
              <button onClick={() => setCurrentFolder(null)} className="hover:text-red-400 transition">Raíz</button>
              {buildBreadcrumbs().map((crumb) => (
                <React.Fragment key={crumb.id}>
                  <span className="text-red-900">/</span>
                  <button onClick={() => setCurrentFolder(crumb.id)} className="hover:text-red-400 transition truncate max-w-[100px]">{crumb.title}</button>
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="flex gap-3 z-10 w-full sm:w-auto">
            <button onClick={() => setModalState({ isOpen: true, type: 'newFolder', item: null, inputValue: '' })} className="flex-1 sm:flex-none bg-neutral-800 border border-neutral-700 text-amber-500 hover:bg-neutral-700 hover:border-amber-600 px-4 py-2 text-sm font-bold tracking-wider uppercase transition">
              + Carpeta
            </button>
            <div className="relative flex-1 sm:flex-none">
              <input type="file" id="file-upload" className="hidden" accept=".pdf,.cbz,.cbr,.txt,.docx,.doc" onChange={handleFileUpload} disabled={isUploading}/>
              <label htmlFor="file-upload" className={`block w-full text-center px-4 py-2 text-sm font-bold tracking-wider uppercase cursor-pointer transition border ${isUploading ? 'bg-neutral-800 border-neutral-700 text-neutral-500' : 'bg-red-950 border-red-800 text-red-200 hover:bg-red-900 hover:shadow-[0_0_10px_rgba(153,27,27,0.5)]'}`}>
                {isUploading ? `Alquimia... ${uploadProgress}%` : '+ Subir Archivo'}
              </label>
            </div>
          </div>
        </div>

        {displayedItems.length === 0 && !isUploading ? (
          <div className="text-center py-24 bg-neutral-900 border border-dashed border-red-900/50">
            <div className="text-5xl mb-4 opacity-20 text-red-500">🕸️</div>
            <h3 className="text-lg text-neutral-500 italic">El vacío reina en esta cámara...</h3>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            
            {/* CARPETAS */}
            {displayedItems.filter(i => i.type === 'folder').map(folder => (
              <div key={folder.id} className="bg-neutral-900 border border-neutral-800 hover:border-amber-700/50 p-4 flex flex-col group transition shadow-lg">
                <div className="flex items-center gap-3 cursor-pointer mb-4" onClick={() => setCurrentFolder(folder.id)}>
                  <div className="text-4xl text-amber-700">📁</div>
                  <h3 className="font-bold text-amber-500 truncate flex-grow">{folder.title}</h3>
                </div>
                <div className="flex gap-2 mt-auto border-t border-neutral-800 pt-3">
                  <button onClick={() => setModalState({ isOpen: true, type: 'rename', item: folder, inputValue: folder.title })} className="text-xs text-neutral-500 hover:text-amber-400">Renombrar</button>
                  <button onClick={() => setModalState({ isOpen: true, type: 'move', item: folder, inputValue: '' })} className="text-xs text-neutral-500 hover:text-indigo-400 ml-auto" title="Mover">📦 Mover</button>
                  <button onClick={() => setModalState({ isOpen: true, type: 'delete', item: folder, inputValue: '' })} className="text-xs text-neutral-500 hover:text-red-500 ml-2">Borrar</button>
                </div>
              </div>
            ))}

            {/* ARCHIVOS (Con portadas generadas dinámicamente) */}
            {displayedItems.filter(i => i.type !== 'folder').map((book) => (
              <div key={book.id} className="bg-neutral-900 border border-neutral-800 hover:border-red-900 transition flex flex-col relative group shadow-lg">
                
                {book.currentPage > 1 && (
                  <div className="absolute top-2 left-2 bg-red-950 border border-red-800 text-red-300 text-xs font-mono px-2 py-0.5 z-10 shadow-md">
                    Pág. {book.currentPage}
                  </div>
                )}

                {/* Etiqueta de Finalizado */}
                {book.status === 'finished' && (
                  <div className="absolute top-2 right-2 bg-amber-900 border border-amber-600 text-amber-300 text-xs font-bold px-2 py-0.5 z-10 shadow-md uppercase">
                    Sellado 🔒
                  </div>
                )}

                {/* Previsualización del documento */}
                <div className="h-48 bg-[#050505] flex items-center justify-center border-b border-neutral-800 cursor-pointer overflow-hidden relative" onClick={() => openBook(book)}>
                  {book.thumbnailUrl ? (
                    <img src={book.thumbnailUrl} alt="Portada" className="w-full h-full object-cover opacity-70 group-hover:opacity-100 group-hover:scale-105 transition duration-500" />
                  ) : (
                    <div className="text-6xl text-red-900 group-hover:scale-110 group-hover:text-red-700 transition duration-500">
                      {book.type === 'pdf' ? '📜' : '🎞️'}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-red-900/20 opacity-0 group-hover:opacity-100 transition duration-300"></div>
                </div>
                
                <div className="p-4 flex flex-col flex-grow">
                  <h3 className="font-bold text-red-200 line-clamp-2 leading-snug mb-1" title={book.title}>
                    {book.title}
                  </h3>
                  <div className="text-xs text-neutral-500 font-mono mb-4">
                    {book.size} • {book.type.toUpperCase()}
                  </div>
                  
                  <div className="flex gap-2 mt-auto border-t border-neutral-800 pt-3">
                    <button onClick={() => setModalState({ isOpen: true, type: 'rename', item: book, inputValue: book.title })} className="text-xs text-neutral-500 hover:text-amber-400" title="Renombrar">✏️</button>
                    <button onClick={() => setModalState({ isOpen: true, type: 'move', item: book, inputValue: '' })} className="text-xs text-neutral-500 hover:text-indigo-400" title="Mover">📦</button>
                    <button onClick={(e) => handleDownload(book, e)} className="text-xs text-neutral-500 hover:text-green-400" title="Descargar al dispositivo">⬇️</button>
                    <button onClick={() => setModalState({ isOpen: true, type: 'delete', item: book, inputValue: '' })} className="text-xs text-neutral-500 hover:text-red-500 ml-auto" title="Destruir">🔥</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ================= MODAL UNIFICADO ================= */}
      {modalState.isOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-neutral-900 border-2 border-red-900 p-6 w-full max-w-sm shadow-[0_0_40px_rgba(150,0,0,0.3)]">
            
            <h3 className="text-xl font-bold text-red-500 mb-4 uppercase tracking-widest border-b border-red-900/50 pb-2">
              {modalState.type === 'newFolder' && "Forjar Carpeta"}
              {modalState.type === 'rename' && "Grabar Nuevo Nombre"}
              {modalState.type === 'move' && "Trasladar Materia"}
              {modalState.type === 'delete' && "Aniquilar Elemento"}
            </h3>

            {(modalState.type === 'newFolder' || modalState.type === 'rename') && (
              <input type="text" value={modalState.inputValue} onChange={(e) => setModalState({...modalState, inputValue: e.target.value})} placeholder="Escribe aquí..." className="w-full bg-neutral-950 border border-neutral-700 text-amber-100 p-2 focus:border-red-500 focus:outline-none mb-6 font-mono" autoFocus />
            )}

            {modalState.type === 'move' && (
              <div className="mb-6 flex flex-col gap-4">
                <div>
                  <p className="text-sm text-neutral-400 mb-2">Selecciona la cámara destino:</p>
                  <select value={modalState.inputValue} onChange={(e) => setModalState({...modalState, inputValue: e.target.value})} className="w-full bg-neutral-950 border border-neutral-700 text-amber-100 p-2 focus:outline-none">
                    <option value="">-- Selecciona --</option>
                    <option value="root">/ Raíz (Archivo Principal)</option>
                    {allItems.filter(i => i.type === 'folder' && i.id !== modalState.item.id).map(f => (
                      <option key={f.id} value={f.id}>🗂️ {f.title}</option>
                    ))}
                  </select>
                </div>
                
                {/* Crear carpeta directamente desde mover */}
                <div className="border-t border-neutral-800 pt-4 mt-2">
                  <p className="text-sm text-neutral-400 mb-2 italic">¿O forjar una cámara nueva aquí?</p>
                  <div className="flex gap-2">
                    <input type="text" value={inlineFolderInput} onChange={e => setInlineFolderInput(e.target.value)} placeholder="Nueva carpeta..." className="w-full bg-neutral-950 border border-neutral-700 text-amber-100 p-2 text-sm focus:border-red-500 focus:outline-none font-mono" />
                    <button onClick={handleCreateInlineFolder} className="bg-red-950 border border-red-800 text-red-200 px-3 text-sm hover:bg-red-900 transition font-bold">Crear</button>
                  </div>
                </div>
              </div>
            )}

            {modalState.type === 'delete' && (
              <p className="text-sm text-red-300 mb-6 font-bold">¿Estás seguro de querer destruir "{modalState.item?.title}"? Esta acción es irreversible.</p>
            )}

            <div className="flex justify-end gap-3">
              <button onClick={closeModal} className="px-4 py-2 text-sm text-neutral-400 hover:text-white border border-transparent hover:border-neutral-700 transition uppercase">Cancelar</button>
              <button onClick={() => {
                  if (modalState.type === 'newFolder') handleCreateFolder();
                  if (modalState.type === 'rename') handleRename();
                  if (modalState.type === 'move') handleMove();
                  if (modalState.type === 'delete') handleDelete();
                }}
                className={`px-4 py-2 text-sm font-bold transition uppercase border ${modalState.type === 'delete' ? 'bg-red-950 text-red-500 border-red-800 hover:bg-red-900 hover:text-white' : 'bg-neutral-800 text-amber-500 border-neutral-700 hover:border-amber-500'}`}>
                Confirmar
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}