import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, serverTimestamp, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';

// 1. VARIABLES DE ENTORNO Y CONFIGURACIÓN
const isCanvas = typeof __firebase_config !== 'undefined';
const canvasAppId = typeof __app_id !== 'undefined' ? __app_id : 'lector-hechizado';

let firebaseConfig = {};

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

// =========================================================================
// COMPONENTE: PÁGINA INDIVIDUAL PARA SCROLL CONTINUO (Solo PDF)
// =========================================================================
const PdfContinuousPage = ({ pdfInstance, pageNum, scaleMode, customScale, readerBrightness, onVisible, containerRef }) => {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        onVisible(pageNum);
        if (!rendered && pdfInstance && canvasRef.current && containerRef.current) {
          pdfInstance.getPage(pageNum).then(page => {
            const baseViewport = page.getViewport({ scale: 1.0 });
            let newScale = 1.2;
            const container = containerRef.current;
            if (scaleMode === 'fit' || scaleMode === 'auto') newScale = Math.min((container.clientWidth - 40) / baseViewport.width, (container.clientHeight - 40) / baseViewport.height);
            else if (scaleMode === 'width') newScale = (container.clientWidth - 40) / baseViewport.width;
            else if (scaleMode === 'height') newScale = (container.clientHeight - 40) / baseViewport.height;
            else if (scaleMode === 'manual') newScale = customScale;

            const outputScale = window.devicePixelRatio || 1;
            const viewport = page.getViewport({ scale: newScale });
            const canvas = canvasRef.current;
            
            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = Math.floor(viewport.width) + "px";
            canvas.style.height = Math.floor(viewport.height) + "px";

            page.render({
              canvasContext: canvas.getContext('2d'),
              transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
              viewport: viewport
            }).promise.then(() => setRendered(true)).catch(e => console.log(e));
          });
        }
      }
    }, { threshold: 0.2, rootMargin: "200px" });

    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [pdfInstance, pageNum, rendered, scaleMode, customScale, onVisible, containerRef]);

  return (
    <div ref={wrapperRef} className="mb-6 shadow-[0_0_30px_rgba(0,0,0,0.8)] bg-white transition-all duration-200" style={{ filter: `brightness(${readerBrightness}%)`, minHeight: rendered ? 'auto' : '60vh', width: 'fit-content', margin: '0 auto 1.5rem auto' }}>
      <canvas ref={canvasRef} className="block" />
      {!rendered && <div className="flex items-center justify-center h-full text-neutral-400">Pág. {pageNum}...</div>}
    </div>
  );
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
  
  // ESTADOS DE TEMAS, DRAG & DROP Y SIDEBAR
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [draggedItem, setDraggedItem] = useState(null);
  const [showSidebar, setShowSidebar] = useState(window.innerWidth > 768);
  
  // ESTADOS DE MODALES Y MENÚ CONTEXTUAL
  const [modalState, setModalState] = useState({ isOpen: false, type: '', item: null, inputValue: '' });
  const [inlineFolderInput, setInlineFolderInput] = useState("");
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0, item: null });
  
  // ESTADOS DEL VISOR DE LECTURA
  const [readingBook, setReadingBook] = useState(null);
  const [pdfInstance, setPdfInstance] = useState(null);
  const [docContent, setDocContent] = useState(null); // Para Word y TXT nativo
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [scaleMode, setScaleMode] = useState('fit');
  const [customScale, setCustomScale] = useState(1.2);
  const [readerBrightness, setReaderBrightness] = useState(100);
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [viewMode, setViewMode] = useState('single'); // 'single' o 'continuous'
  
  const canvasRef = useRef(null);
  const viewerContainerRef = useRef(null);

  // Cargar Polyfill para Drag & Drop
  useEffect(() => {
    const loadPolyfill = () => {
      const script = document.createElement('script');
      script.src = "https://cdn.jsdelivr.net/npm/mobile-drag-drop@2.3.0-rc.2/index.min.js";
      script.onload = () => {
        if (window.MobileDragDrop) {
          window.MobileDragDrop.polyfill({ holdToDrag: 300 });
          window.addEventListener('touchmove', function() {}, {passive: false});
        }
      };
      document.body.appendChild(script);
    };
    loadPolyfill();
  }, []);

  // Cargar motores PDF y conversores
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
    loadScript('https://cdn.jsdelivr.net/npm/unrar-js@0.2.1/dist/unrar.js');
  }, []);

  // Autenticación y Biblioteca
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

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

  // CERRAR MENÚ CONTEXTUAL AL HACER CLIC FUERA
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.show) setContextMenu({ show: false, x: 0, y: 0, item: null });
    };
    window.addEventListener('click', handleClickOutside);
    window.addEventListener('scroll', handleClickOutside, { passive: true });
    return () => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('scroll', handleClickOutside);
    };
  }, [contextMenu.show]);

  // AUTO-GUARDADO DE PÁGINA (Debounce)
  useEffect(() => {
    if (readingBook && currentPage > 0 && currentPage !== readingBook.currentPage) {
      const timer = setTimeout(() => {
        updateDoc(getItemDocRef(user.uid, readingBook.id), { currentPage }).catch(()=>{});
      }, 1500); // Guarda en la nube 1.5s después de que dejaste de mover páginas
      return () => clearTimeout(timer);
    }
  }, [currentPage, readingBook, user]);

  // NAVEGACIÓN POR TECLADO EN EL VISOR
  useEffect(() => {
    if (!readingBook || showFinishModal) return;
    const handleKeyDown = (e) => {
      if (isRendering && viewMode === 'single') return;
      if (e.key === 'Escape') { e.preventDefault(); closeBook(); return; }
      
      // Si estamos en modo continuo, dejamos que el navegador haga el scroll nativo
      if (viewMode === 'continuous' && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;

      if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); changePage(1); } 
      else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); changePage(-1); }
      else if (e.key === '+' || e.key === 'Add') { e.preventDefault(); setScaleMode('manual'); setCustomScale(prev => Math.min(prev + 0.2, 5.0)); }
      else if (e.key === '-' || e.key === 'Subtract') { e.preventDefault(); setScaleMode('manual'); setCustomScale(prev => Math.max(prev - 0.2, 0.4)); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readingBook, currentPage, totalPages, isRendering, showFinishModal, viewMode]);

  const displayedItems = allItems.filter(item => {
    if (currentTab === 'finished') return item.type !== 'folder' && item.status === 'finished';
    if ((item.parentId || null) !== currentFolder) return false;
    return true; 
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

  // ================= EVENTOS DE MENÚ CONTEXTUAL =================
  const handleContextMenu = (e, item) => {
    e.preventDefault();
    let x = e.pageX;
    let y = e.pageY;
    if (x > window.innerWidth - 200) x -= 200;
    if (y > window.innerHeight - 300) y -= 300;
    setContextMenu({ show: true, x, y, item });
  };

  const handleMarkAsSealed = async (item) => {
    try {
      await updateDoc(getItemDocRef(user.uid, item.id), { status: 'finished', finishedAt: serverTimestamp() });
      mostrarMensaje("Tomo sellado y enviado al archivo.");
      setContextMenu({ show: false, x: 0, y: 0, item: null });
    } catch (e) { mostrarMensaje("Fallo al sellar el documento."); }
  };

  const handleUnseal = async (item) => {
    try {
      await updateDoc(getItemDocRef(user.uid, item.id), { status: 'reading' });
      mostrarMensaje("Sello roto. El tomo vuelve a estar activo.");
      setContextMenu({ show: false, x: 0, y: 0, item: null });
    } catch (e) { mostrarMensaje("No se pudo romper el sello."); }
  };

  // ================= FUNCIONES DE ARRASTRE =================
  const handleDragStart = (e, item) => { e.dataTransfer.setData('itemId', item.id); setDraggedItem(item); };
  const handleDragOver = (e) => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-amber-500', 'scale-105'); };
  const handleDragLeave = (e) => { e.currentTarget.classList.remove('ring-2', 'ring-amber-500', 'scale-105'); };
  const handleDrop = async (e, targetFolderId) => {
    e.preventDefault(); e.currentTarget.classList.remove('ring-2', 'ring-amber-500', 'scale-105');
    if (!draggedItem) return;
    if (draggedItem.type === 'folder' && targetFolderId === draggedItem.id) {
      mostrarMensaje("No puedes introducir una cámara dentro de sí misma."); setDraggedItem(null); return;
    }
    if ((draggedItem.parentId || null) === targetFolderId) { setDraggedItem(null); return; }
    try {
      await updateDoc(getItemDocRef(user.uid, draggedItem.id), { parentId: targetFolderId });
      mostrarMensaje("Materia desplazada exitosamente.");
    } catch (err) { mostrarMensaje("Error al mover el archivo."); }
    setDraggedItem(null);
  };

  // ================= ÁRBOL DE JERARQUÍA =================
  const renderFolderTree = (parentId = null, depth = 0) => {
    const folders = allItems.filter(i => i.type === 'folder' && (i.parentId || null) === parentId);
    if (folders.length === 0) return null;
    return (
      <ul className={`pl-${depth > 0 ? '4' : '0'} mt-1 space-y-1`}>
        {folders.map(folder => (
          <li key={folder.id}>
            <div 
              className={`flex items-center gap-2 p-2 rounded cursor-pointer transition ${currentFolder === folder.id ? (isDarkMode ? 'bg-red-900/40 text-amber-500' : 'bg-amber-200 text-amber-900') : (isDarkMode ? 'hover:bg-neutral-800 text-neutral-400' : 'hover:bg-amber-100 text-neutral-700')}`}
              onClick={() => setCurrentFolder(folder.id)} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={(e) => handleDrop(e, folder.id)}
            >
              <span>{currentFolder === folder.id ? '📂' : '📁'}</span>
              <span className="truncate text-sm font-bold">{folder.title}</span>
            </div>
            {renderFolderTree(folder.id, depth + 1)}
          </li>
        ))}
      </ul>
    );
  };

  // ================= AUTENTICACIÓN Y DESCARGAS =================
  const handleLogin = async () => {
    try {
      if (isCanvas) {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token);
        else await signInAnonymously(auth);
      } else { await signInWithPopup(auth, googleProvider); }
    } catch (error) { mostrarMensaje("Las runas rechazan tu acceso."); }
  };

  const handleLogout = async () => { await signOut(auth); setReadingBook(null); setCurrentFolder(null); };

  const handleDownload = async (book, e) => {
    if (e) e.stopPropagation();
    try {
      mostrarMensaje("Canalizando el pergamino a tu dispositivo...");
      const response = await fetch(book.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a'); a.style.display = 'none'; a.href = url;
      a.download = book.title.toLowerCase().endsWith(`.${book.type}`) ? book.title : `${book.title}.${book.type}`;
      document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a);
      mostrarMensaje("¡Descarga completada con éxito! 📦");
    } catch (error) { mostrarMensaje("Fallo al materializar el documento."); }
  };

  // ================= GESTIÓN DE SUBIDA =================
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
    let typeForDb = ext;

    // Transmutaciones exclusivas para CóMICS (CBZ, CBR). Ya no convertimos TXT/DOCX a PDF.
    if (ext === 'cbz' || ext === 'cbr') {
      typeForDb = 'pdf'; // Lo guardamos como PDF
      if (!window.jspdf || (!window.JSZip && ext === 'cbz')) {
        mostrarMensaje("Motores de alquimia apagados. Intenta en 5 segundos.");
        setIsUploading(false); targetInput.value = null; return;
      }
      if (ext === 'cbr' && typeof window.unrar === 'undefined') {
        mostrarMensaje("⚠️ El motor UNRAR no cargó. Usa .CBZ en tu computadora.");
        setIsUploading(false); targetInput.value = null; return;
      }

      mostrarMensaje(`Transmutando cómic ${ext.toUpperCase()} a PDF...`);
      try {
        let imageNames = []; let zip; let unrarData;
        if (ext === 'cbz') {
          zip = await window.JSZip.loadAsync(file);
          imageNames = Object.keys(zip.files).filter(name => !zip.files[name].dir && name.match(/\.(jpe?g|png)$/i)).sort();
        } else if (ext === 'cbr') {
          const buffer = await file.arrayBuffer();
          const extractor = window.unrar.createExtractorFromData(new Uint8Array(buffer));
          unrarData = extractor.extractAll()[0].files.filter(f => !f.fileHeader.flags.directory && f.fileHeader.name.match(/\.(jpe?g|png)$/i));
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
            for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
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
        mostrarMensaje(`Fallo en la transmutación del ${ext.toUpperCase()}.`); setIsUploading(false); targetInput.value = null; return;
      }
    }

    // Generar Miniatura (Portada) solo si es PDF (incluyendo los que acaban de ser transmutados)
    let thumbBlob = null;
    if (typeForDb === 'pdf') {
      try {
        mostrarMensaje("Extrayendo la portada para el archivo...");
        const url = URL.createObjectURL(fileToUpload);
        const pdf = await window.pdfjsLib.getDocument(url).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.5 });
        const outputScale = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
        await page.render({ canvasContext: canvas.getContext('2d'), transform: transform, viewport: viewport }).promise;
        thumbBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        URL.revokeObjectURL(url);
      } catch(e) { console.error("Sin miniatura", e); }
    } else {
      mostrarMensaje(`Almacenando pergamino ${ext.toUpperCase()} original...`);
      setUploadProgress(50); // Simular progreso para archivos nativos
    }

    // Proceso de Subida Final
    const storagePath = `users/${user.uid}/books/${Date.now()}_${fileName}`;
    const storageRef = getStorageFileRef(user.uid, fileName);

    if (isCanvas) {
      let prog = 40;
      const interval = setInterval(() => {
        prog += 10; setUploadProgress(prog);
        if (prog >= 100) {
          clearInterval(interval);
          addDoc(getItemsRef(user.uid), {
            title: fileName, url: URL.createObjectURL(fileToUpload), type: typeForDb, parentId: currentFolder, storagePath,
            thumbnailUrl: thumbBlob ? URL.createObjectURL(thumbBlob) : null, thumbStoragePath: null, createdAt: serverTimestamp(),
            size: (fileToUpload.size / 1024 / 1024).toFixed(2) + ' MB', currentPage: 1, status: 'reading'
          }).then(() => { setIsUploading(false); mostrarMensaje("Grimorio almacenado."); targetInput.value = null; });
        }
      }, 400);
      return;
    }

    const uploadTask = uploadBytesResumable(storageRef, fileToUpload);
    uploadTask.on('state_changed',
      (snapshot) => {
        const base = (typeForDb !== 'pdf') ? 40 : 0; const multiplier = (typeForDb !== 'pdf') ? 0.6 : 1;
        setUploadProgress((base + ((snapshot.bytesTransferred / snapshot.totalBytes) * 100 * multiplier)).toFixed(0));
      },
      () => { mostrarMensaje("La transferencia ha fallado."); setIsUploading(false); },
      async () => {
        try {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          let thumbDownloadURL = null; let thumbStoragePath = null;
          if (thumbBlob) {
            const thumbStorageRef = getStorageFileRef(user.uid, `thumb_${fileName}.jpg`);
            await uploadBytesResumable(thumbStorageRef, thumbBlob);
            thumbDownloadURL = await getDownloadURL(thumbStorageRef);
            thumbStoragePath = thumbStorageRef.fullPath;
          }
          await addDoc(getItemsRef(user.uid), {
            title: fileName, url: downloadURL, type: typeForDb, parentId: currentFolder, storagePath: storageRef.fullPath, 
            thumbnailUrl: thumbDownloadURL, thumbStoragePath, createdAt: serverTimestamp(), size: (fileToUpload.size / 1024 / 1024).toFixed(2) + ' MB', currentPage: 1, status: 'reading'
          });
          setIsUploading(false); mostrarMensaje("Grimorio materializado con éxito."); targetInput.value = null;
        } catch (err) { mostrarMensaje("Fallo al registrar."); setIsUploading(false); }
      }
    );
  };

  // ================= MÁS ACCIONES =================
  const handleCreateFolder = async () => {
    if (!modalState.inputValue.trim()) return;
    try {
      await addDoc(getItemsRef(user.uid), { title: modalState.inputValue.trim(), type: 'folder', parentId: currentFolder, createdAt: serverTimestamp() });
      closeModal(); mostrarMensaje("Cámara forjada.");
    } catch (e) { mostrarMensaje("Error al forjar."); }
  };

  const handleCreateInlineFolder = async () => {
    if (!inlineFolderInput.trim()) return;
    try {
      const newDoc = await addDoc(getItemsRef(user.uid), { title: inlineFolderInput.trim(), type: 'folder', parentId: currentFolder, createdAt: serverTimestamp() });
      setModalState({ ...modalState, inputValue: newDoc.id });
      setInlineFolderInput(""); mostrarMensaje("Cámara forjada.");
    } catch (e) { mostrarMensaje("Error al forjar."); }
  };

  const handleRename = async () => {
    if (!modalState.inputValue.trim() || !modalState.item) return;
    try {
      await updateDoc(getItemDocRef(user.uid, modalState.item.id), { title: modalState.inputValue.trim() });
      closeModal(); mostrarMensaje("Nombre grabado.");
    } catch (e) { mostrarMensaje("Error al renombrar."); }
  };

  const handleMove = async () => {
    if (!modalState.item) return;
    const targetFolder = modalState.inputValue === 'root' ? null : modalState.inputValue;
    if (modalState.item.type === 'folder' && targetFolder === modalState.item.id) return mostrarMensaje("Paradoja evitada.");
    try {
      await updateDoc(getItemDocRef(user.uid, modalState.item.id), { parentId: targetFolder });
      closeModal(); mostrarMensaje("Materia desplazada.");
    } catch (e) { mostrarMensaje("Error en teletransportación."); }
  };

  const handleDelete = async () => {
    if (!modalState.item) return;
    try {
      if (modalState.item.type === 'folder' && allItems.some(i => i.parentId === modalState.item.id)) return mostrarMensaje("La cámara debe estar vacía.");
      await deleteDoc(getItemDocRef(user.uid, modalState.item.id));
      if (modalState.item.type !== 'folder' && !isCanvas) {
        if (modalState.item.storagePath) await deleteObject(ref(storage, modalState.item.storagePath)).catch(()=>null);
        if (modalState.item.thumbStoragePath) await deleteObject(ref(storage, modalState.item.thumbStoragePath)).catch(()=>null);
      }
      closeModal(); mostrarMensaje("Materia reducida a cenizas.");
    } catch (e) { mostrarMensaje("Fallo en la aniquilación."); }
  };

  const handleFinishBook = async () => {
    try {
      await updateDoc(getItemDocRef(user.uid, readingBook.id), { status: 'finished', currentPage: totalPages, finishedAt: serverTimestamp() });
      setShowFinishModal(false); closeBook(); mostrarMensaje("Tomo sellado.");
    } catch (e) { mostrarMensaje("Fallo al sellar."); }
  };

  const closeModal = () => {
    setModalState({ isOpen: false, type: '', item: null, inputValue: '' });
    setInlineFolderInput("");
  };

  // ================= SISTEMA DE LECTURA (Nativo + PDF) =================
  const openBook = async (book) => {
    setReadingBook(book); setCurrentPage(book.currentPage || 1); setTotalPages(0);
    setPdfInstance(null); setDocContent(null); setScaleMode('fit'); setCustomScale(1.2); setReaderBrightness(100); setShowFinishModal(false);
    
    if (!book.startedAt) try { await updateDoc(getItemDocRef(user.uid, book.id), { startedAt: serverTimestamp() }); } catch(e) {}
    
    if (book.type === 'pdf' || !book.type) { // Retrocompatibilidad: Si no tiene tipo, asumimos PDF
      if (window.pdfjsLib) {
        window.pdfjsLib.getDocument(book.url).promise.then(pdf => {
          setPdfInstance(pdf); setTotalPages(pdf.numPages);
        }).catch(() => { mostrarMensaje("Sellos corruptos."); setReadingBook(null); });
      } else { mostrarMensaje("Motores apagados."); setReadingBook(null); }
    } else if (book.type === 'docx' || book.type === 'doc') {
      try {
        const response = await fetch(book.url);
        const arrayBuffer = await response.arrayBuffer();
        const result = await window.mammoth.convertToHtml({ arrayBuffer });
        setDocContent(result.value);
        setTotalPages(1); // Documentos nativos son 1 página larga en web
      } catch(e) { mostrarMensaje("No se pudo descifrar el pergamino Word."); setReadingBook(null); }
    } else if (book.type === 'txt') {
      try {
        const response = await fetch(book.url);
        const text = await response.text();
        setDocContent(text);
        setTotalPages(1);
      } catch(e) { mostrarMensaje("No se pudo descifrar el pergamino de texto."); setReadingBook(null); }
    }
  };

  // EFECTO PRINCIPAL DE RENDERIZADO DEL PDF (Solo para Modo de 1 Hoja)
  useEffect(() => {
    if (pdfInstance && readingBook && viewMode === 'single' && canvasRef.current && viewerContainerRef.current) {
      setIsRendering(true);
      pdfInstance.getPage(currentPage).then(page => {
        const baseViewport = page.getViewport({ scale: 1.0 });
        let newScale = 1.2;
        const container = viewerContainerRef.current;
        if (scaleMode === 'fit' || scaleMode === 'auto') newScale = Math.min((container.clientWidth - 40) / baseViewport.width, (container.clientHeight - 40) / baseViewport.height);
        else if (scaleMode === 'width') newScale = (container.clientWidth - 40) / baseViewport.width;
        else if (scaleMode === 'height') newScale = (container.clientHeight - 40) / baseViewport.height;
        else if (scaleMode === 'manual') newScale = customScale;

        const viewport = page.getViewport({ scale: newScale });
        const canvas = canvasRef.current;
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";

        page.render({ canvasContext: canvas.getContext('2d'), transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null, viewport: viewport })
            .promise.then(() => setIsRendering(false)).catch(() => setIsRendering(false));
      });
    }
  }, [pdfInstance, currentPage, readingBook, scaleMode, customScale, viewMode]);

  const changePage = async (delta) => {
    if (isRendering && viewMode === 'single') return;
    const newPage = currentPage + delta;
    if (newPage > totalPages && readingBook.type === 'pdf') return setShowFinishModal(true);
    if (newPage > 0 && newPage <= totalPages) {
      setCurrentPage(newPage);
      // El guardado ahora se maneja automáticamente por el useEffect debounce
    }
  };

  // CALLBACK OPTIMIZADO PARA ACTUALIZAR LA PÁGINA ACTUAL DURANTE EL SCROLL CONTINUO
  const handleContinuousPageVisible = useCallback((pageNum) => {
    setCurrentPage(pageNum);
  }, []);

  const closeBook = () => { setReadingBook(null); setPdfInstance(null); setDocContent(null); setShowFinishModal(false); };

  // ================= VARIABLES DE TEMA DINÁMICO =================
  const tBgMain = isDarkMode ? 'bg-neutral-950' : 'bg-[#fdf6e3]';
  const tTextMain = isDarkMode ? 'text-red-100' : 'text-amber-950';
  const tBgCard = isDarkMode ? 'bg-neutral-900' : 'bg-white';
  const tBorder = isDarkMode ? 'border-neutral-800' : 'border-amber-200';
  const tBorderHover = isDarkMode ? 'hover:border-red-900' : 'hover:border-amber-500';
  const tHeaderBg = isDarkMode ? 'bg-neutral-900 border-red-900' : 'bg-[#f5e6d3] border-amber-400';
  const tModalBg = isDarkMode ? 'bg-neutral-900 border-red-900 shadow-[0_0_40px_rgba(150,0,0,0.3)]' : 'bg-white border-amber-400 shadow-[0_0_40px_rgba(217,119,6,0.2)]';
  const tInputBg = isDarkMode ? 'bg-neutral-950 border-neutral-700 text-amber-100' : 'bg-amber-50 border-amber-300 text-amber-900';
  const tBtnPrimary = isDarkMode ? 'bg-red-950 border-red-800 text-red-200 hover:bg-red-900' : 'bg-amber-600 border-amber-700 text-white hover:bg-amber-700';
  const tTextAccent = isDarkMode ? 'text-amber-600' : 'text-amber-700';

  // ================= RENDERIZADO DE INTERFAZ =================
  if (!user) {
    return (
      <div className={`min-h-screen ${tBgMain} flex flex-col items-center justify-center p-4 ${tTextMain} font-serif relative overflow-hidden transition-colors duration-300`}>
        <style>{`@font-face { font-family: 'DeadlySins'; src: url('/DeadlySins.ttf') format('truetype'); font-display: swap; } .font-deadly { font-family: 'DeadlySins', serif; }`}</style>
        <div className={`absolute top-0 left-0 w-full h-2 bg-gradient-to-r ${isDarkMode ? 'from-red-950 via-red-800 to-red-950' : 'from-amber-400 via-amber-300 to-amber-400'}`}></div>
        <div className={`max-w-md w-full ${tBgCard} rounded ${isDarkMode ? 'shadow-[0_0_40px_rgba(150,0,0,0.15)]' : 'shadow-xl'} p-10 text-center border-t-2 border-b-2 ${isDarkMode ? 'border-red-900' : 'border-amber-400'} relative z-10`}>
          <div className="text-6xl mb-6 text-amber-600">⚙️📜</div>
          <h1 className="text-5xl font-deadly text-red-600 mb-2 tracking-wider">Lector Hechizado</h1>
          <p className={`${isDarkMode ? 'text-neutral-500' : 'text-amber-800'} mb-10 italic`}>Archivos Mecánicos del Saber Oculto</p>
          <button onClick={handleLogin} className={`w-full flex items-center justify-center gap-3 ${tBtnPrimary} font-bold py-3 px-6 border rounded transition uppercase tracking-widest`}>
            Sellar Pacto (Login)
          </button>
        </div>
      </div>
    );
  }

  // INTERFAZ DE LECTURA (VISOR DE LIBROS)
  if (readingBook) {
    return (
      <div className={`min-h-screen ${tBgMain} flex flex-col items-center justify-start ${tTextMain} font-serif overflow-hidden fixed inset-0 z-40 transition-colors duration-300`}>
        
        {/* Estilos dinámicos para los documentos de Word (Modo Nativo) */}
        <style>{`
          @font-face { font-family: 'DeadlySins'; src: url('/DeadlySins.ttf') format('truetype'); font-display: swap; } 
          .font-deadly { font-family: 'DeadlySins', serif; }
          .docx-viewer { line-height: 1.6; font-family: sans-serif; color: #111; }
          .docx-viewer h1 { font-size: 2em; font-weight: bold; margin-bottom: 0.5em; border-bottom: 2px solid #ddd; padding-bottom: 0.3em; }
          .docx-viewer h2 { font-size: 1.5em; font-weight: bold; margin-bottom: 0.5em; }
          .docx-viewer p { margin-bottom: 1em; }
          .docx-viewer img { max-width: 100%; height: auto; margin: 1em 0; border-radius: 4px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .docx-viewer table { width: 100%; border-collapse: collapse; margin-bottom: 1em; }
          .docx-viewer th, .docx-viewer td { border: 1px solid #ccc; padding: 8px; }
        `}</style>
        
        <div className={`w-full ${tHeaderBg} p-3 shadow-lg flex flex-wrap justify-between items-center border-b z-20 shrink-0 gap-2`}>
          <button onClick={closeBook} className={`text-red-500 hover:text-red-400 px-3 py-1 font-bold transition uppercase tracking-wider text-xs sm:text-sm border border-transparent ${isDarkMode ? 'hover:border-red-900' : 'hover:border-red-300'} rounded z-30`}>
            ⟵ Archivos
          </button>
          
          <div className="flex gap-2 items-center z-30">
            <div className={`hidden sm:flex items-center gap-1 ${tBgMain} px-2 border ${tBorder} rounded`} title="Ajuste de Luz del Lector">
              <span className="text-xs text-neutral-500">🔅</span>
              <input type="range" min="30" max="100" value={readerBrightness} onChange={e => setReaderBrightness(e.target.value)} className="w-16 h-1 bg-neutral-400 rounded-lg appearance-none cursor-pointer accent-red-600" />
              <span className="text-xs text-amber-500">☀️</span>
            </div>

            {/* Alternador de Modo de Vista (Solo útil en PDFs) */}
            {(readingBook.type === 'pdf' || !readingBook.type) && (
              <button onClick={() => setViewMode(v => v === 'single' ? 'continuous' : 'single')} className={`px-2 py-1 text-xs border ${tBorder} ${tTextMain} ${tBorderHover} rounded hidden sm:block`} title="Cambiar modo de lectura">
                {viewMode === 'single' ? '📄 Hoja por Hoja' : '📜 Scroll Continuo'}
              </button>
            )}

            <button onClick={() => setScaleMode('fit')} className={`px-2 py-1 text-xs border ${scaleMode === 'fit' ? 'bg-red-900 border-red-700 text-white' : `${tBorder} ${tTextMain} ${tBorderHover}`}`}>[Ajustar]</button>
            <button onClick={() => setScaleMode('width')} className={`px-2 py-1 text-xs border ${scaleMode === 'width' ? 'bg-red-900 border-red-700 text-white' : `${tBorder} ${tTextMain} ${tBorderHover}`}`}>[↔]</button>
            <button onClick={() => setScaleMode('height')} className={`px-2 py-1 text-xs border ${scaleMode === 'height' ? 'bg-red-900 border-red-700 text-white' : `${tBorder} ${tTextMain} ${tBorderHover}`}`}>[↕]</button>
            <div className={`flex gap-1 ml-2 pl-2 border-l ${tBorder}`}>
               <button onClick={() => { setScaleMode('manual'); setCustomScale(p => Math.max(p - 0.2, 0.4)); }} className={`px-2 py-1 text-xs border ${tBorder} ${tTextMain} ${tBorderHover}`}>[-]</button>
               <button onClick={() => { setScaleMode('manual'); setCustomScale(p => Math.min(p + 0.2, 5.0)); }} className={`px-2 py-1 text-xs border ${tBorder} ${tTextMain} ${tBorderHover}`}>[+]</button>
            </div>
          </div>

          <div className={`text-sm font-mono text-amber-600 font-bold ${tBgMain} px-3 py-1 rounded border ${tBorder} z-30 flex items-center gap-3`}>
            {totalPages > 0 ? `Pág. ${currentPage} / ${totalPages}` : 'Cargando...'}
            {(readingBook.type === 'docx' || readingBook.type === 'txt') && (
               <button onClick={() => setShowFinishModal(true)} className="text-xs bg-red-900 text-white px-2 rounded hover:bg-red-800">Finalizar</button>
            )}
          </div>
        </div>

        <div className="flex-grow w-full overflow-hidden flex flex-col relative">
          
          <div className={`flex-grow w-full overflow-auto flex ${viewMode === 'single' && (readingBook.type === 'pdf' || !readingBook.type) ? 'justify-center items-center' : 'justify-center items-start pt-8'} ${isDarkMode ? 'bg-[#0d0d0d]' : 'bg-[#e5dfd3]'} relative`} ref={viewerContainerRef}>
            
            {/* Si es PDF y está en modo Hoja por Hoja */}
            {(readingBook.type === 'pdf' || !readingBook.type) && viewMode === 'single' ? (
              <>
                <div className="absolute inset-y-0 left-0 w-1/4 z-10 cursor-w-resize" onClick={() => changePage(-1)} title="Página Anterior"></div>
                <div className="absolute inset-y-0 right-0 w-1/4 z-10 cursor-e-resize" onClick={() => changePage(1)} title="Página Siguiente"></div>
                {!pdfInstance && <div className="absolute inset-0 flex items-center justify-center text-red-800 animate-pulse font-bold tracking-widest uppercase">Alineando engranajes... ⚙️</div>}
                <canvas ref={canvasRef} className="shadow-[0_0_30px_rgba(0,0,0,0.8)] bg-white transition-all duration-200 z-0" style={{ display: pdfInstance ? 'block' : 'none', filter: `brightness(${readerBrightness}%)` }}></canvas>
              </>
            ) : 
            
            /* Si es PDF y está en modo Scroll Continuo */
            (readingBook.type === 'pdf' || !readingBook.type) && viewMode === 'continuous' ? (
              <div className="flex flex-col items-center w-full pb-32">
                {!pdfInstance && <div className="text-red-800 animate-pulse font-bold tracking-widest uppercase mt-32">Alineando engranajes... ⚙️</div>}
                {pdfInstance && Array.from({ length: totalPages }, (_, i) => (
                  <PdfContinuousPage 
                    key={`page-${i+1}`} 
                    pdfInstance={pdfInstance} 
                    pageNum={i + 1} 
                    scaleMode={scaleMode} 
                    customScale={customScale} 
                    readerBrightness={readerBrightness} 
                    onVisible={handleContinuousPageVisible}
                    containerRef={viewerContainerRef}
                  />
                ))}
                {pdfInstance && (
                  <button onClick={() => setShowFinishModal(true)} className="mt-8 mb-16 px-8 py-3 bg-red-900 text-white font-bold tracking-widest uppercase rounded shadow-[0_0_15px_rgba(153,27,27,0.8)] hover:bg-red-800 transition">
                    Terminar Tomo
                  </button>
                )}
              </div>
            ) : 
            
            /* Si es un archivo Nativo (Word/TXT) */
            (readingBook.type === 'txt') ? (
              <div className="w-full px-4 flex justify-center pb-16">
                 <pre className="bg-[#fcfcfc] text-[#111] p-6 sm:p-10 shadow-xl max-w-4xl w-full whitespace-pre-wrap font-sans text-sm sm:text-base md:text-lg rounded" style={{ filter: `brightness(${readerBrightness}%)` }}>
                   {docContent || "Descifrando runas..."}
                 </pre>
              </div>
            ) : (
              <div className="w-full px-4 flex justify-center pb-16">
                 <div className="bg-[#fcfcfc] docx-viewer p-6 sm:p-10 shadow-xl max-w-4xl w-full rounded" style={{ filter: `brightness(${readerBrightness}%)` }} dangerouslySetInnerHTML={{ __html: docContent || "<p class='text-center text-red-500 font-bold'>Descifrando runas...</p>" }} />
              </div>
            )}
          </div>

          {/* Barra de progreso inferior */}
          <div className={`w-full ${tHeaderBg} h-1.5 z-20`}>
            <div className="bg-red-600 h-full transition-all duration-300 shadow-[0_0_10px_rgba(220,38,38,1)]" style={{ width: `${totalPages > 0 ? (currentPage / totalPages) * 100 : 0}%` }}></div>
          </div>
        </div>

        {showFinishModal && (
          <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
            <div className={`${tModalBg} p-8 w-full max-w-md text-center relative z-50 rounded`}>
              <div className="text-5xl mb-4 text-amber-600">📜🔒</div>
              <h3 className="text-2xl font-bold text-red-500 mb-4 uppercase tracking-widest border-b border-red-900/50 pb-4">
                El Tomo ha concluido
              </h3>
              <p className={`${tTextMain} mb-8 italic`}>
                Has alcanzado la última página de esta historia. ¿Deseas sellar este grimorio y enviarlo a las profundidades de las Lecturas Finalizadas?
              </p>
              <div className="flex justify-center gap-4">
                <button onClick={() => setShowFinishModal(false)} className={`px-6 py-2 text-sm ${tTextMain} hover:text-red-500 border border-transparent ${tBorderHover} transition uppercase rounded`}>No, aún no</button>
                <button onClick={handleFinishBook} className="px-6 py-2 text-sm font-bold transition uppercase border bg-red-950 text-red-500 border-red-800 hover:bg-red-900 hover:text-white rounded">Sellar Tomo</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ================= RENDERIZADO PRINCIPAL (BIBLIOTECA) =================
  return (
    <div className={`min-h-screen ${tBgMain} ${tTextMain} font-serif pb-10 transition-colors duration-300`}>
      <style>{`@font-face { font-family: 'DeadlySins'; src: url('/DeadlySins.ttf') format('truetype'); font-display: swap; } .font-deadly { font-family: 'DeadlySins', serif; }`}</style>
      
      {systemMessage && (
        <div className="fixed top-4 right-4 bg-red-900 border border-red-500 text-white px-6 py-3 shadow-[0_0_15px_rgba(220,38,38,0.5)] z-50 animate-bounce font-bold tracking-wide rounded">
          {systemMessage}
        </div>
      )}

      {/* MENÚ CONTEXTUAL FLOTANTE */}
      {contextMenu.show && contextMenu.item && (
        <div className={`fixed z-50 ${tModalBg} rounded py-2 w-48 text-sm font-sans`} style={{ top: contextMenu.y, left: contextMenu.x }}>
          <div className={`px-4 py-1 text-xs text-amber-600 font-bold border-b ${tBorder} mb-1 truncate`}>
            {contextMenu.item.title}
          </div>
          <button onClick={() => { setModalState({ isOpen: true, type: 'rename', item: contextMenu.item, inputValue: contextMenu.item.title }); setContextMenu({show: false}); }} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} hover:text-amber-500`}>✏️ Renombrar</button>
          <button onClick={() => { setModalState({ isOpen: true, type: 'move', item: contextMenu.item, inputValue: '' }); setContextMenu({show: false}); }} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} hover:text-indigo-500`}>📦 Mover</button>
          {contextMenu.item.type !== 'folder' && (
            <button onClick={(e) => { handleDownload(contextMenu.item, e); setContextMenu({show: false}); }} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} hover:text-green-500`}>⬇️ Descargar</button>
          )}
          {contextMenu.item.type !== 'folder' && contextMenu.item.status !== 'finished' && (
            <button onClick={() => handleMarkAsSealed(contextMenu.item)} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} hover:text-amber-600 font-bold`}>🔒 Marcar como Sellado</button>
          )}
          {contextMenu.item.type !== 'folder' && contextMenu.item.status === 'finished' && (
            <button onClick={() => handleUnseal(contextMenu.item)} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} hover:text-amber-600 font-bold`}>📖 Quitar Sello</button>
          )}
          <div className={`border-t ${tBorder} mt-1 pt-1`}>
            <button onClick={() => { setModalState({ isOpen: true, type: 'delete', item: contextMenu.item, inputValue: '' }); setContextMenu({show: false}); }} className={`w-full text-left px-4 py-2 ${tTextMain} ${isDarkMode ? 'hover:bg-neutral-800' : 'hover:bg-amber-100'} text-red-500`}>🔥 Destruir</button>
          </div>
        </div>
      )}

      <nav className={`${tHeaderBg} shadow-md border-b-2 sticky top-0 z-30 transition-colors duration-300`}>
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setShowSidebar(!showSidebar)} className={`sm:hidden text-2xl ${tTextAccent} mr-2`} title="Alternar Barra Lateral">☰</button>
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => { setCurrentFolder(null); setCurrentTab('reading'); }} title="Volver a la Raíz">
              <span className="text-2xl text-amber-600 group-hover:rotate-45 transition duration-500">⚙️</span>
              <h1 className="text-2xl font-deadly text-red-600 tracking-widest group-hover:text-red-500 transition mt-1">Lector Hechizado</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setModalState({ isOpen: true, type: 'settings', item: null, inputValue: '' })} className={`text-xl hover:scale-110 transition ${isDarkMode ? '' : 'text-neutral-800'}`} title="Configuración">⚙️</button>
            <span className={`text-sm ${isDarkMode ? 'text-neutral-400' : 'text-amber-800'} italic hidden sm:block`}>Archivista en turno</span>
            <button onClick={handleLogout} className={`text-xs uppercase tracking-widest border ${isDarkMode ? 'border-red-900 text-red-500 hover:bg-red-950' : 'border-red-300 text-red-700 hover:bg-red-100'} hover:text-red-600 px-3 py-1 transition rounded`}>Cerrar Cámara</button>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row mt-6 gap-6 px-4">
        
        {/* SIDEBAR - ÁRBOL DE CARPETAS */}
        <aside className={`${showSidebar ? 'block' : 'hidden'} sm:block w-full sm:w-64 shrink-0`}>
          <div className={`${tBgCard} border ${tBorder} p-4 rounded shadow-md sticky top-24`}>
            <h3 className={`font-bold ${tTextAccent} uppercase tracking-widest text-sm mb-4 border-b ${tBorder} pb-2`}>
              Jerarquía del Archivo
            </h3>
            <div className="overflow-auto max-h-[60vh] custom-scrollbar">
              <div 
                className={`flex items-center gap-2 p-2 rounded cursor-pointer transition ${currentFolder === null ? (isDarkMode ? 'bg-red-900/40 text-amber-500' : 'bg-amber-200 text-amber-900') : (isDarkMode ? 'hover:bg-neutral-800 text-neutral-400' : 'hover:bg-amber-100 text-neutral-700')}`}
                onClick={() => setCurrentFolder(null)}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, null)}
              >
                <span>📚</span>
                <span className="truncate text-sm font-bold">Raíz Principal</span>
              </div>
              {renderFolderTree(null, 0)}
            </div>
            <div className={`mt-4 text-[10px] ${isDarkMode ? 'text-neutral-500' : 'text-amber-700'} italic border-t ${tBorder} pt-2`}>
              🖐️ Arrastra elementos aquí para moverlos.
            </div>
          </div>
        </aside>

        <main className="flex-grow">
          {/* Pestañas (Tabs) Activos vs Finalizados */}
          <div className={`flex gap-4 mb-6 border-b ${tBorder} overflow-x-auto`}>
             <button onClick={() => setCurrentTab('reading')} className={`pb-2 px-4 uppercase font-bold tracking-widest text-sm transition whitespace-nowrap ${currentTab === 'reading' ? `text-amber-500 border-b-2 border-amber-500` : `${isDarkMode ? 'text-neutral-500' : 'text-amber-800'} hover:text-red-500`}`}>
               Lecturas Activas
             </button>
             <button onClick={() => setCurrentTab('finished')} className={`pb-2 px-4 uppercase font-bold tracking-widest text-sm transition whitespace-nowrap ${currentTab === 'finished' ? `text-red-500 border-b-2 border-red-500` : `${isDarkMode ? 'text-neutral-500' : 'text-amber-800'} hover:text-red-500`}`}>
               Tomos Sellados
             </button>
          </div>

          {currentTab === 'reading' && (
            <div className={`${tBgCard} p-6 shadow-md border ${tBorder} rounded mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden`}>
              <div className="absolute -right-6 -top-6 text-6xl opacity-5 text-amber-600 rotate-45 pointer-events-none">⚙️</div>
              <div className="z-10">
                <h2 className="text-2xl font-bold text-red-500 tracking-wide">
                  {currentFolder ? 'Cámara Profunda' : 'Archivo Principal'}
                </h2>
                <div className={`flex items-center gap-2 mt-2 text-sm ${isDarkMode ? 'text-neutral-500' : 'text-amber-800'}`}>
                  <button onClick={() => setCurrentFolder(null)} className="hover:text-red-500 transition" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={(e) => handleDrop(e, null)}>Raíz</button>
                  {buildBreadcrumbs().map((crumb) => (
                    <React.Fragment key={crumb.id}>
                      <span className="text-red-900">/</span>
                      <button onClick={() => setCurrentFolder(crumb.id)} className="hover:text-red-500 transition truncate max-w-[100px]" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={(e) => handleDrop(e, crumb.id)}>{crumb.title}</button>
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <div className="flex gap-3 z-10 w-full md:w-auto">
                <button onClick={() => setModalState({ isOpen: true, type: 'newFolder', item: null, inputValue: '' })} className={`flex-1 md:flex-none ${isDarkMode ? 'bg-neutral-800 text-amber-500 hover:bg-neutral-700' : 'bg-amber-100 text-amber-800 hover:bg-amber-200'} border ${tBorder} px-4 py-2 text-sm font-bold tracking-wider uppercase transition rounded`}>
                  + Carpeta
                </button>
                <div className="relative flex-1 md:flex-none">
                  <input type="file" id="file-upload" className="hidden" accept=".pdf,.cbz,.cbr,.txt,.docx,.doc" onChange={handleFileUpload} disabled={isUploading}/>
                  <label htmlFor="file-upload" className={`block w-full text-center px-4 py-2 text-sm font-bold tracking-wider uppercase cursor-pointer transition rounded ${isUploading ? 'bg-neutral-500 text-white' : tBtnPrimary}`}>
                    {isUploading ? `Alquimia... ${uploadProgress}%` : '+ Subir Archivo'}
                  </label>
                </div>
              </div>
            </div>
          )}

          {displayedItems.length === 0 && !isUploading ? (
            <div className={`text-center py-24 ${tBgCard} border border-dashed ${isDarkMode ? 'border-red-900/50' : 'border-amber-400'} rounded`}>
              <div className="text-5xl mb-4 opacity-20 text-red-500">🕸️</div>
              <h3 className={`text-lg ${isDarkMode ? 'text-neutral-500' : 'text-amber-800'} italic`}>El vacío reina en esta cámara...</h3>
            </div>
          ) : currentTab === 'finished' ? (
            
            <div className={`${tBgCard} border ${tBorder} shadow-lg rounded overflow-hidden`}>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className={`${isDarkMode ? 'bg-neutral-950 border-red-900' : 'bg-amber-100 border-amber-300'} border-b-2 text-amber-600 uppercase tracking-widest text-xs`}>
                      <th className="p-4 w-16 text-center">No.</th>
                      <th className="p-4 min-w-[200px]">Nombre del Tomo</th>
                      <th className="p-4 w-48">Inicio de Lectura</th>
                      <th className="p-4 w-48">Tomo Terminado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedItems.map((book, index) => {
                      const startDate = book.startedAt?.toDate ? book.startedAt.toDate().toLocaleDateString() : (book.createdAt?.toDate ? book.createdAt.toDate().toLocaleDateString() : 'Desconocido');
                      const finishDate = book.finishedAt?.toDate ? book.finishedAt.toDate().toLocaleDateString() : 'Desconocido';
                      return (
                        <tr key={book.id} className={`border-b ${tBorder} ${isDarkMode ? 'hover:bg-neutral-800/80' : 'hover:bg-amber-50'} transition group select-none cursor-pointer`} onContextMenu={(e) => handleContextMenu(e, book)}>
                          <td className="p-4 text-center font-mono text-neutral-500 relative">
                            <span className="group-hover:hidden">{index + 1}</span>
                            <span className="hidden group-hover:inline-block text-amber-500">⋮</span>
                          </td>
                          <td className="p-4">
                            <div className="font-bold text-red-500 cursor-pointer hover:text-red-400 transition" onClick={() => openBook(book)}>{book.title}</div>
                            <div className="text-xs text-neutral-500 font-mono mt-1">{book.size}</div>
                          </td>
                          <td className="p-4 font-mono text-sm text-neutral-500">{startDate}</td>
                          <td className="p-4 font-mono text-sm text-neutral-500">{finishDate}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            
          ) : (
            <div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {displayedItems.filter(i => i.type === 'folder').map(folder => (
                  <div 
                    key={folder.id} 
                    draggable="true"
                    onDragStart={(e) => handleDragStart(e, folder)}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, folder.id)}
                    className={`${tBgCard} border ${tBorder} ${tBorderHover} p-4 rounded flex flex-col group transition shadow-md select-none cursor-pointer relative`}
                    onContextMenu={(e) => handleContextMenu(e, folder)}
                    onClick={() => setCurrentFolder(folder.id)}
                  >
                    <div className="absolute top-2 right-2 text-neutral-400 opacity-0 group-hover:opacity-100 transition">⋮</div>
                    <div className="flex items-center gap-3 mb-2">
                      <div className="text-4xl text-amber-600 drop-shadow-sm">📁</div>
                      <h3 className={`font-bold ${tTextAccent} truncate flex-grow`}>{folder.title}</h3>
                    </div>
                  </div>
                ))}

                {displayedItems.filter(i => i.type !== 'folder').map((book) => {
                  const isFinished = book.status === 'finished';
                  return (
                  <div 
                    key={book.id} 
                    draggable="true"
                    onDragStart={(e) => handleDragStart(e, book)}
                    className={`${tBgCard} border rounded ${isFinished ? (isDarkMode ? 'border-amber-900/40 opacity-75 hover:opacity-100 grayscale-[30%]' : 'border-amber-300 opacity-80 hover:opacity-100 grayscale-[10%]') : `${tBorder} ${tBorderHover}`} transition flex flex-col relative group shadow-md select-none cursor-pointer`}
                    onContextMenu={(e) => handleContextMenu(e, book)}
                  >
                    <div className="absolute top-2 right-2 z-10 text-white bg-black/50 rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">⋮</div>
                    
                    {book.currentPage > 1 && !isFinished && (
                      <div className={`absolute top-2 left-2 ${isDarkMode ? 'bg-red-950 border-red-800 text-red-300' : 'bg-red-100 border-red-300 text-red-800'} text-xs font-mono px-2 py-0.5 z-10 shadow-md rounded`}>
                        Pág. {book.currentPage}
                      </div>
                    )}

                    {isFinished && (
                      <div className={`absolute top-2 left-2 ${isDarkMode ? 'bg-amber-950 border-amber-700 text-amber-400' : 'bg-amber-100 border-amber-400 text-amber-800'} text-xs font-bold px-2 py-0.5 z-10 shadow-md uppercase rounded backdrop-blur-sm`}>
                        Sellado 🔒
                      </div>
                    )}

                    <div className={`h-48 ${isDarkMode ? 'bg-[#050505]' : 'bg-[#e5dfd3]'} flex items-center justify-center border-b ${tBorder} overflow-hidden relative rounded-t`} onClick={() => openBook(book)}>
                      {book.thumbnailUrl ? (
                        <img src={book.thumbnailUrl} alt="Portada" className={`w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition duration-500 pointer-events-none ${isFinished && !isDarkMode ? 'mix-blend-multiply' : ''}`} />
                      ) : (
                        <div className={`text-6xl ${isFinished ? 'text-amber-700 group-hover:text-amber-500' : 'text-red-800 group-hover:text-red-600'} group-hover:scale-110 transition duration-500`}>
                          {book.type === 'pdf' || !book.type ? '📜' : '📝'}
                        </div>
                      )}
                      <div className={`absolute inset-0 ${isFinished ? 'bg-amber-900/10' : 'bg-red-900/10'} opacity-0 group-hover:opacity-100 transition duration-300`}></div>
                    </div>
                    
                    <div className="p-4 flex flex-col flex-grow" onClick={() => openBook(book)}>
                      <h3 className={`font-bold ${isFinished ? 'text-amber-600' : 'text-red-500'} line-clamp-2 leading-snug mb-1`} title={book.title}>
                        {book.title}
                      </h3>
                      <div className="text-xs text-neutral-500 font-mono">
                        {book.size} • {(book.type || 'PDF').toUpperCase()}
                      </div>
                    </div>
                  </div>
                )})}
              </div>
              <div className={`mt-8 text-center text-[11px] ${isDarkMode ? 'text-neutral-500 bg-neutral-500/10' : 'text-amber-700 bg-amber-500/10'} uppercase tracking-widest p-2 rounded`}>
                ✨ Mantén presionado un elemento para sus opciones • 🖐️ Arrástralo para moverlo
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ================= MODALES (CREAR, RENOMBRAR, MOVER, BORRAR, CONFIGURACIÓN) ================= */}
      {modalState.isOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className={`${tModalBg} p-6 w-full max-w-sm rounded`}>
            
            {modalState.type === 'settings' ? (
              <>
                <h3 className="text-xl font-bold text-red-500 mb-4 uppercase tracking-widest border-b border-red-900/50 pb-2">Configuración</h3>
                <div className="mb-6">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" checked={isDarkMode} onChange={(e) => setIsDarkMode(e.target.checked)} />
                      <div className={`block w-14 h-8 rounded-full transition ${isDarkMode ? 'bg-red-900' : 'bg-neutral-400'}`}></div>
                      <div className={`dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition transform ${isDarkMode ? 'translate-x-6' : ''}`}></div>
                    </div>
                    <span className={`font-bold ${tTextMain}`}>Tema Gótico Oscuro</span>
                  </label>
                  <p className="text-xs text-neutral-500 mt-2 italic">Apágalo para revelar el Pergamino Iluminado.</p>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xl font-bold text-red-500 mb-4 uppercase tracking-widest border-b border-red-900/50 pb-2">
                  {modalState.type === 'newFolder' && "Forjar Carpeta"}
                  {modalState.type === 'rename' && "Grabar Nuevo Nombre"}
                  {modalState.type === 'move' && "Trasladar Materia"}
                  {modalState.type === 'delete' && "Aniquilar Elemento"}
                </h3>

                {(modalState.type === 'newFolder' || modalState.type === 'rename') && (
                  <input type="text" value={modalState.inputValue} onChange={(e) => setModalState({...modalState, inputValue: e.target.value})} placeholder="Escribe aquí..." className={`w-full ${tInputBg} p-2 focus:ring-2 focus:ring-red-500 focus:outline-none mb-6 font-mono rounded`} autoFocus />
                )}

                {modalState.type === 'move' && (
                  <div className="mb-6 flex flex-col gap-4">
                    <div>
                      <p className={`text-sm ${isDarkMode ? 'text-neutral-400' : 'text-amber-800'} mb-2`}>Selecciona la cámara destino:</p>
                      <select value={modalState.inputValue} onChange={(e) => setModalState({...modalState, inputValue: e.target.value})} className={`w-full ${tInputBg} p-2 focus:outline-none rounded`}>
                        <option value="">-- Selecciona --</option>
                        <option value="root">/ Raíz (Archivo Principal)</option>
                        {allItems.filter(i => i.type === 'folder' && i.id !== modalState.item.id).map(f => (
                          <option key={f.id} value={f.id}>🗂️ {f.title}</option>
                        ))}
                      </select>
                    </div>
                    <div className={`border-t ${tBorder} pt-4 mt-2`}>
                      <p className={`text-sm ${isDarkMode ? 'text-neutral-400' : 'text-amber-800'} mb-2 italic`}>¿O forjar una cámara nueva aquí?</p>
                      <div className="flex gap-2">
                        <input type="text" value={inlineFolderInput} onChange={e => setInlineFolderInput(e.target.value)} placeholder="Nueva carpeta..." className={`w-full ${tInputBg} p-2 text-sm focus:ring-2 focus:ring-red-500 focus:outline-none font-mono rounded`} />
                        <button onClick={handleCreateInlineFolder} className={`${tBtnPrimary} px-3 text-sm transition font-bold rounded`}>Crear</button>
                      </div>
                    </div>
                  </div>
                )}

                {modalState.type === 'delete' && (
                  <p className="text-sm text-red-500 mb-6 font-bold">¿Estás seguro de querer destruir "{modalState.item?.title}"? Esta acción es irreversible.</p>
                )}
              </>
            )}

            <div className="flex justify-end gap-3 mt-4">
              <button onClick={closeModal} className={`px-4 py-2 text-sm ${tTextMain} hover:text-red-500 border border-transparent ${tBorderHover} transition uppercase rounded`}>Cerrar</button>
              {modalState.type !== 'settings' && (
                <button onClick={() => {
                    if (modalState.type === 'newFolder') handleCreateFolder();
                    if (modalState.type === 'rename') handleRename();
                    if (modalState.type === 'move') handleMove();
                    if (modalState.type === 'delete') handleDelete();
                  }}
                  className={`px-4 py-2 text-sm font-bold transition uppercase border rounded ${modalState.type === 'delete' ? 'bg-red-950 text-red-500 border-red-800 hover:bg-red-900 hover:text-white' : tBtnPrimary}`}>
                  Confirmar
                </button>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
}