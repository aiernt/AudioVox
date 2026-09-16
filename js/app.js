// ---------- Bands we cover ----------
const BANDS = [
  { artist: "Stone Temple Pilots", image: "stone-temple-pilots.jpg" },
  { artist: "Harvey Danger", image: "harvey-danger.jpg" },
  { artist: "Blink 182", image: "blink-182.jpg" },
  { artist: "Eve 6", image: "eve-6.jpg" },
  { artist: "Weezer", image: "weezer.jpg" },
  { artist: "Foo Fighters", image: "foo-fighters.jpg" },
  { artist: "Fuel", image: "fuel.jpg" },
  { artist: "Radiohead", image: "radiohead.jpg" },
  { artist: "Creed", image: "creed.jpg" },
  { artist: "Green Day", image: "green-day.jpg" },
  { artist: "Pearl Jam", image: "pearl-jam.jpg" },
  { artist: "Better Than Ezra", image: "better-than-ezra.jpg" },
  { artist: "Spacehog", image: "spacehog.jpg" },
  { artist: "Seven Mary 3", image: "seven-mary-3.jpg" },
  { artist: "Everclear", image: "everclear.jpg" },
  { artist: "Toadies", image: "toadies.jpg" },
  { artist: "Kings of Leon", image: "kings-of-leon.jpg" },
  { artist: "Sublime", image: "sublime.jpg" },
  { artist: "Rage Against the Machine", image: "rage-against-the-machine.jpg" },
  { artist: "HIM", image: "him.jpg" },
  { artist: "Lenny Kravitz", image: "lenny-kravitz.jpg" },
  { artist: "Bowling for Soup", image: "bowling-for-soup.jpg" },
  { artist: "Blur", image: "blur.jpg" },
  { artist: "Nirvana", image: "nirvana.jpg" },
  { artist: "Lifehouse", image: "lifehouse.jpg" },
  { artist: "Matchbox 20", image: "matchbox-20.jpg" },
  { artist: "Eagle-Eye Cherry", image: "eagle-eye-cherry.jpg" },
  { artist: "Violent Femmes", image: "violent-femmes.jpg" },
  { artist: "Soundgarden", image: "soundgarden.jpg" },
  { artist: "Collective Soul", image: "collective-soul.jpg" },
  { artist: "Lemonheads", image: "lemonheads.jpg" },
  { artist: "3 Doors Down", image: "3-doors-down.jpg" },
  { artist: "Audioslave", image: "audioslave.jpg" },
  { artist: "The Killers", image: "the-killers.jpg" },
  { artist: "Local H", image: "local-h.jpg" },
  { artist: "Lit", image: "lit.jpg" },
  { artist: "James", image: "james.jpg" },
  { artist: "Finger Eleven", image: "finger-eleven.jpg" },
  { artist: "Beastie Boys", image: "beastie-boys.jpg" },
  { artist: "Goo Goo Dolls", image: "goo-goo-dolls.jpg" },
  { artist: "Jet", image: "jet.jpg" }
];

// ---------- Gallery ----------
// To add a photo: drop the file into /images, then add one line below.
const GALLERY_IMAGES = [
  { file: "gallery-1.jpg", alt: "" },
  { file: "gallery-2.jpg", alt: "" },
  { file: "gallery-3.jpg", alt: "" },
  { file: "gallery-4.jpg", alt: "" },
  { file: "gallery-5.jpg", alt: "" },
  { file: "gallery-6.jpg", alt: "" },
  { file: "gallery-7.jpg", alt: "" },
  { file: "gallery-8.jpg", alt: "" },
  { file: "gallery-9.jpg", alt: "" },
  { file: "gallery-10.jpg", alt: "" },
  { file: "gallery-11.jpg", alt: "" },
  { file: "gallery-12.jpg", alt: "" },
  { file: "gallery-13.jpg", alt: "" },
  { file: "gallery-14.jpg", alt: "" },
  { file: "gallery-15.jpg", alt: "" },
  { file: "gallery-16.jpg", alt: "" },
  { file: "gallery-17.jpg", alt: "" },
  { file: "gallery-18.jpg", alt: "" },
  { file: "gallery-19.jpg", alt: "" },
  { file: "gallery-20.jpg", alt: "" },
  { file: "gallery-21.jpg", alt: "" },
  { file: "gallery-22.jpg", alt: "" },
  { file: "gallery-23.jpg", alt: "" },
  { file: "gallery-24.jpg", alt: "" },
  { file: "gallery-25.jpg", alt: "" },
  { file: "gallery-26.jpg", alt: "" },
  { file: "gallery-27.jpg", alt: "" },
  { file: "gallery-28.jpg", alt: "" },
  { file: "gallery-29.jpg", alt: "" }
];

// Each BANDS entry can carry an optional `image` (e.g. { artist: "...", image: "file.jpg" }).
// If set, drop the file in /images/bands and it's used as the tile's photo;
// otherwise the tile falls back to its generated color gradient.
function hueFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

const COVER_BANDS = BANDS.map(({ artist }) => artist);

const bandImages = {};
BANDS.forEach(({ artist, image }) => {
  if (image) bandImages[artist] = image;
});

const coverBandsGrid = document.getElementById("cover-bands-grid");
if (coverBandsGrid) {
  COVER_BANDS.forEach((band) => {
    const li = document.createElement("li");
    li.className = "cover-band-art";
    li.style.setProperty("--hue", hueFromName(band));

    const imageFile = bandImages[band];
    if (imageFile) {
      const photo = document.createElement("img");
      photo.className = "cover-band-photo";
      photo.src = `images/bands/${imageFile}`;
      photo.alt = "";
      photo.loading = "lazy";
      // If the file's missing, just remove it - the color gradient underneath still shows.
      photo.addEventListener("error", () => photo.remove());
      li.appendChild(photo);
    }

    const name = document.createElement("span");
    name.className = "cover-band-name";
    name.textContent = band;
    li.appendChild(name);
    coverBandsGrid.appendChild(li);
  });

  // On touch devices (no real hover), reveal each tile's full color as it
  // scrolls into view instead of requiring a tap. Desktop keeps :hover.
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    const bandObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("in-view", entry.isIntersecting);
        });
      },
      { rootMargin: "-35% 0px -15% 0px" }
    );
    coverBandsGrid.querySelectorAll(".cover-band-art").forEach((tile) => bandObserver.observe(tile));
  }
}

// ---------- Header scroll state ----------
const header = document.getElementById("site-header");
function onScroll() {
  header.classList.toggle("scrolled", window.scrollY > 40);
}
document.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---------- Scroll-spy nav highlighting ----------
const navSectionIds = ["about", "gallery", "setlist", "shows", "videos", "book"];
const navLinkBySection = {};
navSectionIds.forEach((id) => {
  const link = document.querySelector(`.nav-link[href="#${id}"]`);
  if (link) navLinkBySection[id] = link;
});

const sectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      Object.values(navLinkBySection).forEach((link) => link.classList.remove("is-active"));
      navLinkBySection[entry.target.id]?.classList.add("is-active");
    });
  },
  { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
);

navSectionIds.forEach((id) => {
  const section = document.getElementById(id);
  if (section) sectionObserver.observe(section);
});

// ---------- Mobile nav ----------
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");
navToggle.addEventListener("click", () => {
  const isOpen = navLinks.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
  document.body.classList.toggle("nav-open", isOpen);
});
navLinks.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("nav-open");
  });
});

// ---------- Photo fallback ----------
// If a real photo hasn't been dropped into /images yet, show a labeled
// placeholder instead of a broken image icon.
function bindPhotoFallback(img) {
  img.addEventListener("error", () => {
    const label = img.dataset.fallbackLabel || "image";
    const span = document.createElement("span");
    span.textContent = `Drop a photo here: ${label}`;
    span.className = img.className + " is-missing";
    img.replaceWith(span);
  });
}
document.querySelectorAll(".photo-fallback").forEach(bindPhotoFallback);

// ---------- Gallery (Swiper.js coverflow) ----------
// Swiper handles touch/drag/loop itself - it's a proven, widely-used library
// built specifically to deal with the iOS touch-event quirks that made a
// hand-rolled drag carousel unreliable.
const galleryWrapper = document.getElementById("gallery-wrapper");

if (galleryWrapper) {
  GALLERY_IMAGES.forEach(({ file, alt }) => {
    const src = `images/gallery/${file}`;
    const slide = document.createElement("div");
    slide.className = "swiper-slide";
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    img.loading = "lazy";
    img.className = "photo-fallback gallery-photo lightbox-trigger";
    img.dataset.lightboxGroup = "gallery";
    img.dataset.fallbackLabel = src;
    bindPhotoFallback(img);
    slide.appendChild(img);
    galleryWrapper.appendChild(slide);
  });

  new Swiper(".gallery-swiper", {
    effect: "coverflow",
    grabCursor: true,
    centeredSlides: true,
    loop: true,
    slidesPerView: "auto",
    coverflowEffect: {
      rotate: 30,
      stretch: 0,
      depth: 150,
      modifier: 1,
      slideShadows: false,
    },
    navigation: {
      nextEl: "#gallery-next",
      prevEl: "#gallery-prev",
    },
  });
}

// ---------- Lightbox ----------
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

let lightboxPhotos = [];
let lightboxIndex = 0;

function showLightboxPhoto(index) {
  if (!lightboxPhotos.length) return;
  lightboxIndex = (index + lightboxPhotos.length) % lightboxPhotos.length;
  const el = lightboxPhotos[lightboxIndex];
  lightboxImg.src = el.dataset.src || el.currentSrc || el.src || "";
  lightboxImg.alt = el.dataset.alt || el.alt || "";
}

function openLightbox(img) {
  const group = img.dataset.lightboxGroup || "";
  lightboxPhotos = Array.from(
    document.querySelectorAll(".lightbox-trigger:not(.is-missing)")
  ).filter(
    (el) => (el.dataset.lightboxGroup || "") === group && !el.closest(".swiper-slide-duplicate")
  );
  const startIndex = lightboxPhotos.indexOf(img);
  const hasMultiple = lightboxPhotos.length > 1;
  lightboxPrev.hidden = !hasMultiple;
  lightboxNext.hidden = !hasMultiple;
  showLightboxPhoto(startIndex === -1 ? 0 : startIndex);
  lightbox.hidden = false;
  document.body.classList.add("lightbox-open");
}
function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = "";
  document.body.classList.remove("lightbox-open");
}

document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".lightbox-trigger:not(.is-missing)");
  // Swiper clones slides internally (for the loop effect) and marks the
  // clones with this class - skip them so the lightbox doesn't treat a
  // photo as appearing multiple times in the sequence.
  if (trigger && !trigger.closest(".swiper-slide-duplicate")) openLightbox(trigger);
});
lightboxClose.addEventListener("click", closeLightbox);
lightboxPrev.addEventListener("click", () => showLightboxPhoto(lightboxIndex - 1));
lightboxNext.addEventListener("click", () => showLightboxPhoto(lightboxIndex + 1));
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") showLightboxPhoto(lightboxIndex - 1);
  if (e.key === "ArrowRight") showLightboxPhoto(lightboxIndex + 1);
});

// ---------- Next show flyer ----------
// Drop a poster into images/flyer.jpg to promote the next gig on the
// hero. If it's missing, the whole tilted/taped flyer just doesn't render.
const nextShow = document.getElementById("next-show");
const nextShowImg = document.getElementById("next-show-img");
if (nextShow && nextShowImg) {
  nextShowImg.addEventListener("error", () => nextShow.remove());
}

// ---------- Booking form modal ----------
// NOTE: submission is currently stubbed - it validates the form and shows the
// success screen, but does not actually send anything anywhere yet. The
// composed message is logged to the console so it can be reviewed before we
// wire up a real send (mailto link or a form-backend service).
const bookingModal = document.getElementById("booking-modal");
const openBookingBtn = document.getElementById("open-booking-form");
const bookingClose = document.getElementById("booking-close");
const bookingCloseSuccess = document.getElementById("booking-close-success");
const bookingFormWrap = document.getElementById("booking-form-wrap");
const bookingForm = document.getElementById("booking-form");
const bookingSuccess = document.getElementById("booking-success");
const bookingMathLabel = document.getElementById("booking-math-label");
const bookingMathInput = document.getElementById("booking-math-input");
const bookingMathError = document.getElementById("booking-math-error");

let bookingMathAnswer = 0;
function newBookingMathQuestion() {
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  bookingMathAnswer = a + b;
  bookingMathLabel.textContent = `Quick check: what's ${a} + ${b}?`;
}

function openBookingModal() {
  bookingModal.hidden = false;
  document.body.classList.add("modal-open");
  newBookingMathQuestion();
}
function closeBookingModal() {
  bookingModal.hidden = true;
  document.body.classList.remove("modal-open");
  bookingForm.reset();
  bookingFormWrap.hidden = false;
  bookingSuccess.hidden = true;
  bookingMathError.hidden = true;
}

if (openBookingBtn) {
  openBookingBtn.addEventListener("click", openBookingModal);
  bookingClose.addEventListener("click", closeBookingModal);
  bookingCloseSuccess.addEventListener("click", closeBookingModal);
  bookingModal.addEventListener("click", (e) => {
    if (e.target === bookingModal) closeBookingModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !bookingModal.hidden) closeBookingModal();
  });

  bookingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(bookingForm).entries());

    // Honeypot: real visitors never see or fill this field, so if it's
    // filled, quietly pretend to succeed without actually logging anything.
    if (data.website) {
      bookingFormWrap.hidden = true;
      bookingSuccess.hidden = false;
      return;
    }

    if (parseInt(bookingMathInput.value, 10) !== bookingMathAnswer) {
      bookingMathError.hidden = false;
      newBookingMathQuestion();
      bookingMathInput.value = "";
      bookingMathInput.focus();
      return;
    }

    // TODO: replace this with a real send once the delivery method is confirmed.
    console.log("Booking request (not yet sent):", data);
    bookingFormWrap.hidden = true;
    bookingSuccess.hidden = false;
  });
}

// ---------- Footer year ----------
document.getElementById("year").textContent = new Date().getFullYear();
