// ----------------------------------------------------------------------------
// CometMask.js — build a comet mask from a user-drawn nucleus + tail polygon.
//
// Milestone 1: Dialog skeleton + STF preview canvas. All control panels are
// laid out per the locked spec but are inert (no handlers). The preview canvas
// loads the active view's image, auto-stretches it via STF, renders to a
// Bitmap, and paints fit-to-canvas. OK / Cancel just close.
//
// PJSR script for PixInsight 1.8.x.
// ----------------------------------------------------------------------------


#feature-id    Utilities > CometMask
#feature-info  Build a comet mask from a user-drawn nucleus circle plus a \
               tail polygon, with independent falloff and Gaussian softening \
               per region.


#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/BitmapInterpolation.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/ButtonCodes.jsh>
#include <pjsr/ImageOp.jsh>


#define TITLE   "CometMask"
#define VERSION "0.7.2"


// Settings prefix for persisted geometry + parameters.
#define SETTINGS_PREFIX "CometMask/"


// Tool modes
#define TOOL_IDLE             0
#define TOOL_PLACE_NUCLEUS    1
#define TOOL_ADD_TAIL_VERTEX  2
#define TOOL_AUTO_DETECT      3


// Hit-test and overlay sizes (canvas-screen pixels)
#define HANDLE_HIT_RADIUS    10
#define HANDLE_DRAW_RADIUS    5
#define EDGE_HIT_RADIUS       6


// Overlay colors (0xAARRGGBB)
#define COLOR_NUCLEUS_OUTLINE    0xffff8800   // orange
#define COLOR_HANDLE_CENTER      0xffffff00   // yellow
#define COLOR_HANDLE_RIM         0xff66ddff   // cyan
#define COLOR_HANDLE_OUTLINE     0xff000000   // black
#define COLOR_TAIL_OUTLINE       0xffe040ff   // magenta
#define COLOR_TAIL_VERTEX        0xffffffff   // white
#define COLOR_TAIL_ANCHOR_LINKED 0xffffff00   // yellow (matches nucleus center)
#define COLOR_TAIL_ANCHOR_FREE   0xffffffff   // white


// ----------------------------------------------------------------------------
// Auto-stretch helpers for the preview canvas.
//
// The math here is the conventional PixInsight auto-stretch: for each
// channel, clip shadows (or highlights, if the histogram is concentrated
// near 1) at `median + shadowsClipping · 1.4826·MAD`, then warp midtones
// so the median lands at `targetMedian`. The MAD scaling factor 1.4826
// makes a median absolute deviation coherent with the standard deviation
// of a normal distribution.
// ----------------------------------------------------------------------------


// Build and apply a screen transfer function that stretches the view's
// display. `shadowsClip` is the number of MAD-equivalent sigmas below the
// median to clip (typically negative, e.g. -2.8). `targetMedian` is where
// the stretched histogram's median should land (typically 0.25). `link`
// means RGB channels share one stretch.
function computeAndApplyAutoStretch( view, shadowsClip, targetMedian, link )
{
   var image    = view.image;
   var nChans   = image.isColor ? 3 : 1;
   var medians  = view.computeOrFetchProperty( "Median" );
   var devs     = view.computeOrFetchProperty( "MAD" );
   devs.mul( 1.4826 );


   // Per-channel STF row = [shadows, highlights, midtones, rangeMin, rangeMax].
   // Allocate four rows (the fourth is the alpha/luma slot PixInsight uses
   // for mono images), default identity, then fill the channels we touch.
   var stfRows = [
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1] ];


   // Helper: stretch one channel from its median + MAD. Returns an STF row.
   function rowForChannel( ch )
   {
      var med  = medians.at( ch );
      var dev  = devs.at( ch );
      var safe = (1 + dev != 1);   // guard against dev == 0 → /0
      if ( med < 0.5 )
      {
         // Histogram concentrated low (normal astrophoto).
         var shadows = safe
            ? Math.range( med + shadowsClip * dev, 0, 1 )
            : 0;
         var mid = Math.mtf( targetMedian, med - shadows );
         return [shadows, 1, mid, 0, 1];
      }
      // Histogram concentrated high (inverted).
      var highs = safe
         ? Math.range( med - shadowsClip * dev, 0, 1 )
         : 1;
      var mid = Math.mtf( highs - med, targetMedian );
      return [0, highs, mid, 0, 1];
   }


   if ( link && nChans > 1 )
   {
      // Linked: average channel medians + MADs, decide inversion by
      // majority vote, then write the same row into R, G, B.
      var hiCount = 0;
      for ( var ch = 0; ch < nChans; ++ch )
         if ( medians.at( ch ) > 0.5 ) ++hiCount;
      var inverted = (hiCount == nChans);


      var avgMed = 0, avgClip = 0;
      for ( var ch = 0; ch < nChans; ++ch )
      {
         var med  = medians.at( ch );
         var dev  = devs.at( ch );
         var safe = (1 + dev != 1);
         avgMed += med;
         if ( inverted )
            avgClip += safe ? (med - shadowsClip * dev) : 1;
         else if ( safe )
            avgClip += med + shadowsClip * dev;
      }
      avgMed  /= nChans;
      avgClip  = Math.range( avgClip / nChans, 0, 1 );


      var row;
      if ( inverted )
      {
         var mid = Math.mtf( avgClip - avgMed, targetMedian );
         row = [0, avgClip, mid, 0, 1];
      }
      else
      {
         var mid = Math.mtf( targetMedian, avgMed - avgClip );
         row = [avgClip, 1, mid, 0, 1];
      }
      stfRows[0] = row;
      stfRows[1] = row;
      stfRows[2] = row;
   }
   else
   {
      // Unlinked (or mono): each channel gets its own row.
      for ( var ch = 0; ch < nChans; ++ch )
         stfRows[ch] = rowForChannel( ch );
   }


   var stf = new ScreenTransferFunction;
   stf.STF = stfRows;
   stf.executeOn( view );
}


// "Bake" the view's screen-only STF into its pixel data, so a subsequent
// image.render() returns the stretched view. Constructs the equivalent
// HistogramTransformation, resets the screen STF back to identity (so the
// HT we then apply isn't visually compounded with the residual screen
// stretch), then runs the HT.
function bakeStretchIntoPixels( view )
{
   var currentStf = view.stf;
   var isColor    = view.image.isColor;


   // HistogramTransformation.H rows are [shadows, midtones, highlights,
   // rangeMin, rangeMax]; the fifth row is the alpha/luma slot. The STF
   // rows are [shadows, highlights, midtones, rangeMin, rangeMax] — note
   // the different ordering of "highlights" and "midtones". We translate
   // by copying STF's highlights (index 1) into HT's shadows column, and
   // STF's shadows (index 0) into HT's midtones column. For mono images,
   // the fifth (alpha/luma) HT row carries the translation; for color,
   // each of the three RGB rows does.
   var htRows = [
      [0, 0.5, 1, 0, 1],
      [0, 0.5, 1, 0, 1],
      [0, 0.5, 1, 0, 1],
      [0, 0.5, 1, 0, 1],
      [0, 0.5, 1, 0, 1] ];


   if ( isColor )
   {
      for ( var ch = 0; ch < 3; ++ch )
      {
         htRows[ch][0] = currentStf[ch][1];   // HT shadows ← STF highlights
         htRows[ch][1] = currentStf[ch][0];   // HT midtones ← STF shadows
      }
   }
   else
   {
      htRows[3][0] = currentStf[0][1];
      htRows[3][1] = currentStf[0][0];
   }


   // Identity STF so the on-screen display matches the pixel data after
   // the HT runs.
   var identity = new ScreenTransferFunction;
   view.stf = [
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1],
      [0, 1, 0.5, 0, 1] ];
   identity.executeOn( view );


   var ht = new HistogramTransformation;
   ht.H = htRows;
   ht.executeOn( view );
}


// Cursor to use when hovering the canvas in a given tool mode.
function cursorForToolMode( mode )
{
   if ( mode == TOOL_PLACE_NUCLEUS ) return StdCursor_Cross;
   if ( mode == TOOL_ADD_TAIL_VERTEX ) return StdCursor_Cross;
   if ( mode == TOOL_AUTO_DETECT ) return StdCursor_Cross;
   return StdCursor_Arrow;
}


// Heuristic linear/non-linear classifier. Linear astrophotos sit with their
// histogram concentrated near zero (sky is dark, only stars are bright);
// stretched images push the median up toward mid-gray. The 0.05 cutoff is
// the conventional one used by other PJSR scripts (e.g., the AdP toolkit).
// Used to decide whether the preview should auto-apply STF on dialog open
// — we want STF on for linear images (otherwise they show as near-black)
// and off for stretched images (otherwise STF over-brightens them).
function isLikelyLinear( srcView )
{
   try
   {
      var med = srcView.computeOrFetchProperty( "Median" );
      var n = srcView.image.numberOfChannels;
      var sum = 0;
      for ( var c = 0; c < n; ++c ) sum += med.at( c );
      return (sum / n) < 0.05;
   }
   catch ( ex )
   {
      // If we can't compute the property for any reason, fall back to
      // "treat as linear" so the preview is at least visible.
      return true;
   }
}


// Render the source view's image directly to a Bitmap, respecting whatever
// STF the view itself has set (identity if none). Used when the user
// disables auto-STF preview — they see the image as PixInsight would
// display it on its own. For a linear image with no STF this looks dark.
function makeRawBitmap( srcView )
{
   var bmp = new Bitmap( srcView.image.width, srcView.image.height );
   bmp.assign( srcView.image.render() );
   return bmp;
}


// Build an STF-baked Bitmap from a source view, without touching the source.
function makeStretchedBitmap( srcView )
{
   var w = srcView.image.width;
   var h = srcView.image.height;
   var nc = srcView.image.numberOfChannels;
   var isColor = srcView.image.isColor;


   var tmpW = new ImageWindow( w, h, nc, 32, true, isColor, "_cm_preview_tmp" );
   tmpW.hide();
   tmpW.mainView.beginProcess( UndoFlag_NoSwapFile );
   tmpW.mainView.image.assign( srcView.image );
   tmpW.mainView.endProcess();


   try
   {
      computeAndApplyAutoStretch( tmpW.mainView, -2.80, 0.25, true );
      bakeStretchIntoPixels( tmpW.mainView );


      var bmp = new Bitmap( w, h );
      bmp.assign( tmpW.mainView.image.render() );
      return bmp;
   }
   finally
   {
      tmpW.forceClose();
   }
}


// ============================================================================
// Engine — distance fields, falloff, blur, combine, output.
//
// The engine is decoupled from the UI: it takes a `params` object built by
// the dialog at OK time and produces one or more new ImageWindows. Internal
// math is in JavaScript Float32Array; bulk image read/write goes through
// Matrix.toImage / Image.toMatrix.toArray to avoid per-pixel PCL crossings.
// Output windows are 32-bit float single-channel (matches the convention
// used by shipped PJSR mask scripts).
// ============================================================================


// Yield to PixInsight so the Process Console actually flushes during long
// JS loops. Without this, the console is frozen until the script returns
// and the user can't tell whether the script is making progress or stuck.
// Also propagates the user's Abort button (the red square on the Process
// Console) by checking Console.abortRequested.
function pumpEvents()
{
   try { processEvents(); } catch ( e ) {}
   if ( typeof Console != "undefined" && Console.abortRequested )
      throw new Error( "Aborted by user." );
}


// Log a progress line in long loops. `cur` is the current step (0-based or
// 1-based, doesn't matter as long as it's consistent), `total` is the
// total number of steps. We pump events after each line so the console
// updates live.
function logProgress( label, cur, total )
{
   var pct = (total > 0) ? Math.floor( cur * 100 / total ) : 0;
   Console.writeln( "    [", ("  " + pct).slice( -3 ), "%] ", label,
      "  ", cur, " / ", total );
   pumpEvents();
}


// Pick a "log every N steps" interval that gives ~10 progress lines.
function progressInterval( total )
{
   return Math.max( 1, Math.floor( total / 10 ) );
}


function uniqueViewId( baseId )
{
   if ( View.viewById( baseId ).isNull ) return baseId;
   for ( var i = 1; i < 10000; ++i )
   {
      var id = baseId + '_' + i;
      if ( View.viewById( id ).isNull ) return id;
   }
   return baseId + '_x';   // hopelessly contended; let PI sort it out
}


// Build the tail outline as a flat array of source-image-space Points.
// At smooth==0 returns the polygon vertices in order. At smooth>0 each
// edge is replaced with a Catmull-Rom-derived cubic Bezier sampled at
// 32 points/segment. The result is treated as a closed polygon by the
// rasterizer and ray-caster (no closing-point appended; indices wrap
// modulo length).
function buildTailPath( tail, smooth )
{
   if ( tail == null ) return [];
   var verts = tail.vertices;
   var n = verts.length;
   if ( n < 3 ) return [];


   var s = smooth / 6.0;
   var samplesPerSegment = (smooth > 0) ? 32 : 1;
   var path = [];
   for ( var i = 0; i < n; ++i )
   {
      var p0 = verts[(i - 1 + n) % n];
      var p1 = verts[i];
      var p2 = verts[(i + 1) % n];
      var p3 = verts[(i + 2) % n];
      var b1x = p1.x + (p2.x - p0.x) * s;
      var b1y = p1.y + (p2.y - p0.y) * s;
      var b2x = p2.x - (p3.x - p1.x) * s;
      var b2y = p2.y - (p3.y - p1.y) * s;
      for ( var k = 0; k < samplesPerSegment; ++k )
      {
         var t = k / samplesPerSegment;
         var u = 1 - t;
         var x = u*u*u*p1.x + 3*u*u*t*b1x + 3*u*t*t*b2x + t*t*t*p2.x;
         var y = u*u*u*p1.y + 3*u*u*t*b1y + 3*u*t*t*b2y + t*t*t*p2.y;
         path.push( new Point( x, y ) );
      }
   }
   return path;
}


// Scanline-fill rasterization of a closed polygon into a Uint8Array
// (1 inside, 0 outside). Even-odd rule, sampling at y+0.5.
function rasterizePolygon( path, w, h )
{
   var mask = new Uint8Array( w * h );
   var n = path.length;
   if ( n < 3 ) return mask;


   var step = progressInterval( h );
   for ( var y = 0; y < h; ++y )
   {
      var ys = y + 0.5;
      var crossings = [];
      for ( var i = 0; i < n; ++i )
      {
         var a = path[i];
         var b = path[(i + 1) % n];
         var ay = a.y, by = b.y;
         if ( (ay <= ys && by > ys) || (by <= ys && ay > ys) )
         {
            var t = (ys - ay) / (by - ay);
            crossings.push( a.x + t * (b.x - a.x) );
         }
      }
      crossings.sort( function( p, q ) { return p - q; } );
      var rowOff = y * w;
      for ( var k = 0; k + 1 < crossings.length; k += 2 )
      {
         var x0 = Math.max( 0, Math.ceil( crossings[k] ) );
         var x1 = Math.min( w - 1, Math.floor( crossings[k + 1] ) );
         for ( var x = x0; x <= x1; ++x )
            mask[rowOff + x] = 1;
      }
      if ( y % step == 0 ) logProgress( "rasterize polygon (rows)", y, h );
   }
   logProgress( "rasterize polygon (rows)", h, h );
   return mask;
}


// 1D squared-distance transform (Felzenszwalb / Huttenlocher 2012).
// Given a row of "heights" src[i] (0 at boundary cells, INF at interior),
// computes dst[i] = min_j ( src[j] + (i - j)^2 ). Scratch arrays v and z
// must be at least length n and n+1 respectively, allocated by caller.
function dt1d( src, dst, n, v, z )
{
   var INF = 1e20;
   var k = 0;
   v[0] = 0;
   z[0] = -INF;
   z[1] =  INF;
   for ( var q = 1; q < n; ++q )
   {
      var vk = v[k];
      var s = ( (src[q] + q*q) - (src[vk] + vk*vk) ) / (2*q - 2*vk);
      while ( k > 0 && s <= z[k] )
      {
         --k;
         vk = v[k];
         s = ( (src[q] + q*q) - (src[vk] + vk*vk) ) / (2*q - 2*vk);
      }
      ++k;
      v[k] = q;
      z[k] = s;
      z[k+1] = INF;
   }
   k = 0;
   for ( var q = 0; q < n; ++q )
   {
      while ( z[k+1] < q ) ++k;
      var d = q - v[k];
      dst[q] = d*d + src[v[k]];
   }
}


// Squared Euclidean distance transform of a binary mask: for each cell
// where mask==1, returns the squared distance to the nearest cell where
// mask==0. Cells with mask==0 get distance 0. Two-pass O(w*h).
function squaredDistanceTransform( mask, w, h )
{
   var INF = 1e20;
   var maxDim = Math.max( w, h );
   var f = new Float64Array( maxDim );
   var d = new Float64Array( maxDim );
   var v = new Int32Array( maxDim );
   var z = new Float64Array( maxDim + 1 );
   var dt = new Float64Array( w * h );


   // Pass 1: rows
   var stepH = progressInterval( h );
   for ( var y = 0; y < h; ++y )
   {
      for ( var x = 0; x < w; ++x )
         f[x] = (mask[y*w + x] == 1) ? INF : 0;
      dt1d( f, d, w, v, z );
      for ( var x = 0; x < w; ++x )
         dt[y*w + x] = d[x];
      if ( y % stepH == 0 ) logProgress( "distance transform pass 1 (rows)", y, h );
   }
   logProgress( "distance transform pass 1 (rows)", h, h );


   // Pass 2: columns
   var stepW = progressInterval( w );
   for ( var x = 0; x < w; ++x )
   {
      for ( var y = 0; y < h; ++y )
         f[y] = dt[y*w + x];
      dt1d( f, d, h, v, z );
      for ( var y = 0; y < h; ++y )
         dt[y*w + x] = d[y];
      if ( x % stepW == 0 ) logProgress( "distance transform pass 2 (cols)", x, w );
   }
   logProgress( "distance transform pass 2 (cols)", w, w );
   return dt;
}


// Float32Array → fresh single-channel Image via Matrix.toImage().
function arrayToImage( arr, w, h )
{
   // Matrix takes a regular Array of doubles; copying from typed array.
   // For huge images (60M+ elements) this copy is non-trivial, so log it.
   var n = arr.length;
   Console.writeln( "    arrayToImage: copying ", n, " values…" );
   pumpEvents();
   var ra = new Array( n );
   var step = progressInterval( n );
   for ( var i = 0; i < n; ++i )
   {
      ra[i] = arr[i];
      if ( i % step == 0 && i > 0 ) logProgress( "arrayToImage copy", i, n );
   }
   logProgress( "arrayToImage copy", n, n );
   Console.writeln( "    arrayToImage: building Matrix + Image…" );
   pumpEvents();
   return new Matrix( ra, h, w ).toImage();
}


// Single-channel Image → Float32Array via toMatrix().toArray().
function imageToArray( image )
{
   var w = image.width, h = image.height;
   Console.writeln( "    imageToArray: extracting matrix…" );
   pumpEvents();
   var arr = image.toMatrix().toArray();
   var n = arr.length;
   Console.writeln( "    imageToArray: copying ", n, " values…" );
   pumpEvents();
   var out = new Float32Array( n );
   var step = progressInterval( n );
   for ( var i = 0; i < n; ++i )
   {
      out[i] = arr[i];
      if ( i % step == 0 && i > 0 ) logProgress( "imageToArray copy", i, n );
   }
   logProgress( "imageToArray copy", n, n );
   return out;
}


// Apply a parametric Gaussian blur to an array in place by routing through
// a transient ImageWindow + PJSR Convolution process.
function gaussianBlurArray( arr, w, h, sigma )
{
   if ( sigma <= 0 ) return;


   // Force GC before allocating the next big ImageWindow + Matrix. Without
   // this, the leftover ~240 MB Matrix from the previous step's
   // arrayToImage seems to push the next ImageWindow into a state where
   // apply() throws "read-only image" inside beginProcess.
   try { gc(); } catch ( e ) {}


   var win = new ImageWindow( w, h, 1, 32, true, false,
      uniqueViewId( "_cm_blur_tmp" ) );
   try
   {
      win.hide();


      // First try the fast bulk path (apply with ImageOp_Mov). If that
      // throws, the view's image becomes read-only for the remainder of
      // this beginProcess block — even the cached `img` reference and
      // setSample fail. Recovery is to endProcess, beginProcess again to
      // get a fresh writable state, and use setSample in that clean block.
      var bulkOK = false;
      win.mainView.beginProcess( UndoFlag_NoSwapFile );
      try
      {
         var img = win.mainView.image;
         img.fill( 0 );
         img.apply( arrayToImage( arr, w, h ), ImageOp_Mov );
         bulkOK = true;
      }
      catch ( e1 )
      {
         Console.warningln( "<end><cbr>  → bulk write failed (",
            e1.toString(), "); recovering for per-pixel fallback..." );
      }
      win.mainView.endProcess();


      if ( !bulkOK )
      {
         // Fresh beginProcess cycle to recover writability after the
         // failed apply. Slow but reliable.
         try { gc(); } catch ( e ) {}
         win.mainView.beginProcess( UndoFlag_NoSwapFile );
         var img2 = win.mainView.image;
         img2.fill( 0 );
         var step = progressInterval( h );
         for ( var y = 0; y < h; ++y )
         {
            var rowOff = y * w;
            for ( var x = 0; x < w; ++x )
               img2.setSample( arr[rowOff + x], x, y, 0 );
            if ( y % step == 0 )
               logProgress( "blur input setSample (rows)", y, h );
         }
         logProgress( "blur input setSample (rows)", h, h );
         win.mainView.endProcess();
      }


      var P = new Convolution;
      P.mode = Convolution.prototype.Parametric;
      P.sigma = sigma;
      P.shape = 2.0;
      P.aspectRatio = 1.0;
      P.rotationAngle = 0.0;
      P.rescaleHighPass = false;
      P.executeOn( win.mainView );


      var read = imageToArray( win.mainView.image );
      for ( var i = 0; i < arr.length; ++i ) arr[i] = read[i];
   }
   finally
   {
      win.forceClose();
   }
}


// ============================================================================
// Auto-detect comet helpers. Used by the "Auto Detect Comet" tool, which
// turns one click on the comet head into a nucleus ellipse + tail polygon
// based on brightness flood-fill. Standalone free functions so they're
// callable from the dialog without a full engine instance.
// ============================================================================


// Build a brightness array for detection. Mono images use the fast
// toMatrix() bulk path; color images compute Rec.709 luma per-pixel at
// the downsampled grid. Returns { arr, w, h, dsFactor }. dsFactor > 1
// when the source is larger than targetMaxPixels.
function readDetectionImage( srcView, targetMaxPixels )
{
   var w = srcView.image.width;
   var h = srcView.image.height;
   var img = srcView.image;
   var total = w * h;
   var dsFactor = 1;
   if ( total > targetMaxPixels )
      dsFactor = Math.ceil( Math.sqrt( total / targetMaxPixels ) );
   var dw = Math.ceil( w / dsFactor );
   var dh = Math.ceil( h / dsFactor );


   Console.writeln( "    detection grid: ", dw, "×", dh, " (downsample ×", dsFactor, ")" );
   pumpEvents();


   var arr;
   if ( img.isColor )
   {
      arr = new Float32Array( dw * dh );
      var step = progressInterval( dh );
      for ( var dy = 0; dy < dh; ++dy )
      {
         var sy = Math.min( h - 1, dy * dsFactor );
         var rowOff = dy * dw;
         for ( var dx = 0; dx < dw; ++dx )
         {
            var sx = Math.min( w - 1, dx * dsFactor );
            arr[rowOff + dx] = 0.2126 * img.sample( sx, sy, 0 )
                             + 0.7152 * img.sample( sx, sy, 1 )
                             + 0.0722 * img.sample( sx, sy, 2 );
         }
         if ( dy % step == 0 ) logProgress( "auto-detect luma (rows)", dy, dh );
      }
      logProgress( "auto-detect luma (rows)", dh, dh );
   }
   else
   {
      if ( dsFactor == 1 )
      {
         arr = imageToArray( img );
      }
      else
      {
         var full = imageToArray( img );
         arr = new Float32Array( dw * dh );
         for ( var dy = 0; dy < dh; ++dy )
         {
            for ( var dx = 0; dx < dw; ++dx )
            {
               var sx = Math.min( w - 1, dx * dsFactor );
               var sy = Math.min( h - 1, dy * dsFactor );
               arr[dy * dw + dx] = full[sy * w + sx];
            }
         }
      }
   }
   return { arr: arr, w: dw, h: dh, dsFactor: dsFactor };
}


// 4-connected flood fill from (startX, startY) including all pixels with
// arr[i] >= threshold. Returns an array of pixel indices.
function floodFillThreshold( arr, w, h, startX, startY, threshold )
{
   if ( startX < 0 || startX >= w || startY < 0 || startY >= h ) return [];
   var startIdx = startY * w + startX;
   if ( arr[startIdx] < threshold ) return [];
   var visited = new Uint8Array( w * h );
   var found = [];
   var stack = [ startIdx ];
   visited[startIdx] = 1;
   while ( stack.length > 0 )
   {
      var idx = stack.pop();
      if ( arr[idx] < threshold ) continue;
      found.push( idx );
      var y = Math.floor( idx / w );
      var x = idx - y * w;
      if ( x > 0 && !visited[idx - 1] )
      {
         visited[idx - 1] = 1;
         stack.push( idx - 1 );
      }
      if ( x < w - 1 && !visited[idx + 1] )
      {
         visited[idx + 1] = 1;
         stack.push( idx + 1 );
      }
      if ( y > 0 && !visited[idx - w] )
      {
         visited[idx - w] = 1;
         stack.push( idx - w );
      }
      if ( y < h - 1 && !visited[idx + w] )
      {
         visited[idx + w] = 1;
         stack.push( idx + w );
      }
   }
   return found;
}


// Fit an oriented ellipse to a set of pixel indices with the ellipse
// CENTER FORCED to (cx, cy) — the user's click point. The principal axis
// direction still comes from the centroid-based covariance (so the
// ellipse's orientation reflects the bright region's elongation), but
// the half-axis lengths are the 95th-percentile of pixel-to-(cx,cy)
// distance projected onto each axis. Result: ellipse is anchored at the
// click and radiates outward to cover ~95% of the bright pixels along
// each principal direction, robust to a few outlier pixels.
function fitEllipseCenteredAt( indices, w, cx, cy )
{
   var n = indices.length;
   if ( n < 4 ) return null;


   // Centroid-based covariance for the major-axis direction only.
   var sumX = 0, sumY = 0;
   for ( var i = 0; i < n; ++i )
   {
      var idx = indices[i];
      var py = Math.floor( idx / w );
      var px = idx - py * w;
      sumX += px;
      sumY += py;
   }
   var mx = sumX / n;
   var my = sumY / n;
   var Sxx = 0, Syy = 0, Sxy = 0;
   for ( var i = 0; i < n; ++i )
   {
      var idx = indices[i];
      var py = Math.floor( idx / w );
      var px = idx - py * w;
      var dxc = px - mx;
      var dyc = py - my;
      Sxx += dxc * dxc;
      Syy += dyc * dyc;
      Sxy += dxc * dyc;
   }
   Sxx /= n; Syy /= n; Sxy /= n;


   var trace = Sxx + Syy;
   var det   = Sxx * Syy - Sxy * Sxy;
   var disc  = Math.sqrt( Math.max( 0, trace * trace / 4 - det ) );
   var lambda1 = trace / 2 + disc;


   // Major eigenvector for lambda1.
   var ex, ey;
   if ( Math.abs( Sxy ) > 1e-9 )
   {
      ex = lambda1 - Syy;
      ey = Sxy;
   }
   else if ( Sxx >= Syy )
   {
      ex = 1; ey = 0;
   }
   else
   {
      ex = 0; ey = 1;
   }
   var elen = Math.sqrt( ex * ex + ey * ey );
   if ( elen < 1e-9 ) { ex = 1; ey = 0; }
   else { ex /= elen; ey /= elen; }
   var fx = -ey, fy = ex;                  // minor axis ⟂ major
   var theta = Math.atan2( ey, ex );


   // Project each bright pixel onto the major / minor axes FROM the
   // forced center (cx, cy), not from the centroid. The half-axis length
   // along each axis is the 95th-percentile of |projection|.
   var pmArr = new Array( n );
   var pnArr = new Array( n );
   for ( var i = 0; i < n; ++i )
   {
      var idx = indices[i];
      var py = Math.floor( idx / w );
      var px = idx - py * w;
      var dxk = px - cx;
      var dyk = py - cy;
      pmArr[i] = Math.abs( dxk * ex + dyk * ey );
      pnArr[i] = Math.abs( dxk * fx + dyk * fy );
   }
   pmArr.sort( function( a, b ) { return a - b; } );
   pnArr.sort( function( a, b ) { return a - b; } );
   var pIdx = Math.min( n - 1, Math.floor( n * 0.95 ) );
   var Rx = Math.max( 1, pmArr[pIdx] );
   var Ry = Math.max( 1, pnArr[pIdx] );


   return { x: cx, y: cy, Rx: Rx, Ry: Ry, theta: theta };
}


// Andrew's monotone chain. Input: array of { x, y } points. Returns the
// convex hull as an ordered array of points (counter-clockwise).
function convexHullFromPoints( points )
{
   var n = points.length;
   if ( n <= 2 ) return points.slice();
   var pts = points.slice();
   pts.sort( function( a, b ) {
      if ( a.x != b.x ) return a.x - b.x;
      return a.y - b.y;
   } );
   function cross( o, a, b ) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
   }
   var lower = [];
   for ( var i = 0; i < n; ++i )
   {
      while ( lower.length >= 2 &&
              cross( lower[lower.length-2], lower[lower.length-1], pts[i] ) <= 0 )
         lower.pop();
      lower.push( pts[i] );
   }
   var upper = [];
   for ( var i = n - 1; i >= 0; --i )
   {
      while ( upper.length >= 2 &&
              cross( upper[upper.length-2], upper[upper.length-1], pts[i] ) <= 0 )
         upper.pop();
      upper.push( pts[i] );
   }
   lower.pop();
   upper.pop();
   return lower.concat( upper );
}


// Reduce a polygon to roughly `targetCount` vertices by even sampling.
function simplifyByVertexCount( polygon, targetCount )
{
   var n = polygon.length;
   if ( n <= targetCount ) return polygon.slice();
   var step = n / targetCount;
   var out = [];
   for ( var i = 0; i < targetCount; ++i )
   {
      var idx = Math.floor( i * step );
      if ( idx >= n ) idx = n - 1;
      out.push( polygon[idx] );
   }
   return out;
}


// Auto-detect nucleus + tail from one click on the comet head. Returns
// { nucleus, tail } in source-image coordinates.
function autoDetectComet( srcView, clickX, clickY, sensitivity )
{
   Console.writeln( "<end><cbr><br>", TITLE, " auto-detect at (",
      clickX.toFixed(0), ", ", clickY.toFixed(0), "), sensitivity ",
      Math.round( sensitivity * 100 ), "%" );
   Console.abortEnabled = true;
   pumpEvents();
   var t0 = (new Date).getTime();


   var TARGET_PIXELS = 4e6;
   var det = readDetectionImage( srcView, TARGET_PIXELS );


   // Click → detection grid coords.
   var dcx = Math.round( clickX / det.dsFactor );
   var dcy = Math.round( clickY / det.dsFactor );
   if ( dcx < 0 ) dcx = 0;
   if ( dcx >= det.w ) dcx = det.w - 1;
   if ( dcy < 0 ) dcy = 0;
   if ( dcy >= det.h ) dcy = det.h - 1;


   var vClick = det.arr[dcy * det.w + dcx];
   Console.writeln( "    click brightness: ", vClick.toFixed( 4 ) );
   pumpEvents();
   if ( vClick <= 1e-6 )
      throw new Error( "Click point appears to be on background (brightness ≈ 0). " +
         "Click directly on the comet head." );


   // Threshold mapping: at sensitivity 0 we only accept pixels nearly as
   // bright as the click; at sensitivity 1 we accept pixels down to 5%
   // of click brightness.
   var tailThreshold    = vClick * (0.95 - 0.90 * sensitivity);
   var nucleusThreshold = vClick * 0.65;
   if ( nucleusThreshold < tailThreshold ) nucleusThreshold = tailThreshold;
   Console.writeln( "    tail threshold = ", tailThreshold.toFixed( 4 ),
                    ",  nucleus threshold = ", nucleusThreshold.toFixed( 4 ) );
   pumpEvents();


   Console.writeln( "    flood-filling bright region from click point…" );
   pumpEvents();
   var tailIndices = floodFillThreshold( det.arr, det.w, det.h, dcx, dcy, tailThreshold );
   Console.writeln( "    region contains ", tailIndices.length, " pixels" );
   pumpEvents();
   if ( tailIndices.length < 16 )
      throw new Error( "Auto-detect: too few bright pixels (" + tailIndices.length +
         "). Click closer to the comet head or increase Sensitivity." );


   // Nucleus core = pixels brighter than nucleusThreshold. If too few,
   // fall back to the brightest ~30% of the region.
   var nucleusIndices = [];
   for ( var i = 0; i < tailIndices.length; ++i )
      if ( det.arr[tailIndices[i]] >= nucleusThreshold )
         nucleusIndices.push( tailIndices[i] );
   if ( nucleusIndices.length < 4 )
   {
      var sorted = tailIndices.slice();
      sorted.sort( function( a, b ) { return det.arr[b] - det.arr[a]; } );
      nucleusIndices = sorted.slice( 0, Math.max( 4, Math.floor( sorted.length * 0.30 ) ) );
   }
   Console.writeln( "    nucleus core: ", nucleusIndices.length, " pixels" );
   pumpEvents();


   var ellipse = fitEllipseCenteredAt( nucleusIndices, det.w, dcx, dcy );
   if ( ellipse == null )
      throw new Error( "Auto-detect: failed to fit nucleus ellipse." );
   Console.writeln( "    nucleus ellipse: anchored at click, Rx=",
      ellipse.Rx.toFixed(1), " Ry=", ellipse.Ry.toFixed(1),
      " θ=", (ellipse.theta * 180/Math.PI).toFixed(1), "°" );
   pumpEvents();


   Console.writeln( "    convex hull of tail region…" );
   pumpEvents();
   var sampleStep = Math.max( 1, Math.floor( tailIndices.length / 5000 ) );
   var tailPoints = [];
   for ( var i = 0; i < tailIndices.length; i += sampleStep )
   {
      var idx = tailIndices[i];
      var ty = Math.floor( idx / det.w );
      var tx = idx - ty * det.w;
      tailPoints.push( { x: tx, y: ty } );
   }
   var hull = convexHullFromPoints( tailPoints );
   Console.writeln( "    convex hull: ", hull.length, " vertices, simplifying to ~12" );
   pumpEvents();
   var simplified = simplifyByVertexCount( hull, 12 );


   // Scale back to source coords. Nucleus center is forced to the exact
   // click point in source coords (not the scaled-back grid centroid), so
   // the mask radiates outward from where the user clicked.
   var dsf = det.dsFactor;
   var nucleus = {
      x: clickX,
      y: clickY,
      Rx: Math.max( 2, ellipse.Rx * dsf ),
      Ry: Math.max( 2, ellipse.Ry * dsf ),
      theta: ellipse.theta
   };
   var tailVerts = [];
   for ( var i = 0; i < simplified.length; ++i )
      tailVerts.push( new Point( simplified[i].x * dsf, simplified[i].y * dsf ) );


   // Re-anchor: find the convex-hull vertex closest to the nucleus
   // center, rotate the array so it's at index 0, then snap it exactly
   // to the nucleus center (matches the Link-tail-to-nucleus semantics).
   var anchorIdx = 0;
   var minDistSq = Infinity;
   for ( var i = 0; i < tailVerts.length; ++i )
   {
      var ddx = tailVerts[i].x - nucleus.x;
      var ddy = tailVerts[i].y - nucleus.y;
      var dsq = ddx*ddx + ddy*ddy;
      if ( dsq < minDistSq ) { minDistSq = dsq; anchorIdx = i; }
   }
   if ( anchorIdx > 0 )
      tailVerts = tailVerts.slice( anchorIdx ).concat( tailVerts.slice( 0, anchorIdx ) );
   tailVerts[0] = new Point( nucleus.x, nucleus.y );


   var elapsed = ((new Date).getTime() - t0) / 1000;
   Console.writeln( "    done in ", elapsed.toFixed( 2 ), "s" );


   return {
      nucleus: nucleus,
      tail: { vertices: tailVerts, anchorIndex: 0 }
   };
}


// ---- CometMaskEngine ------------------------------------------------------


function CometMaskEngine( srcView, params )
{
   this.srcView = srcView;
   this.params = params;
   this.w = srcView.image.width;
   this.h = srcView.image.height;
}


// Returns { falloff: Float32Array, region: Uint8Array } where falloff is
// the per-pixel mask value 0..1 (after the linear core-fraction ramp) and
// region is a 1-inside / 0-outside indicator. The region is needed for
// directional softening (Inward / Outward) to gate the Gaussian blur.
CometMaskEngine.prototype.computeNucleusFalloff = function()
{
   var w = this.w, h = this.h;
   var arr = new Float32Array( w * h );
   var rgn = new Uint8Array( w * h );
   var n = this.params.nucleus;
   if ( n == null ) return { falloff: arr, region: rgn };
   var core = this.params.nucleusCore;
   var invInvCore = 1 / Math.max( 1e-9, 1 - core );


   var theta = n.theta || 0;
   var cosT = Math.cos( theta );
   var sinT = Math.sin( theta );
   var invRx = 1 / Math.max( 1e-6, n.Rx );
   var invRy = 1 / Math.max( 1e-6, n.Ry );


   var step = progressInterval( h );
   for ( var y = 0; y < h; ++y )
   {
      var dyW = y + 0.5 - n.y;
      var rowOff = y * w;
      for ( var x = 0; x < w; ++x )
      {
         var dxW = x + 0.5 - n.x;
         var lx = (dxW * cosT + dyW * sinT) * invRx;
         var ly = (-dxW * sinT + dyW * cosT) * invRy;
         var d = Math.sqrt( lx*lx + ly*ly );
         var v;
         if ( d <= core ) v = 1;
         else if ( d >= 1 ) v = 0;
         else v = (1 - d) * invInvCore;
         arr[rowOff + x] = v;
         if ( d < 1 ) rgn[rowOff + x] = 1;
      }
      if ( y % step == 0 ) logProgress( "nucleus falloff (rows)", y, h );
   }
   logProgress( "nucleus falloff (rows)", h, h );
   return { falloff: arr, region: rgn };
};


CometMaskEngine.prototype.computeTailFalloff = function()
{
   var w = this.w, h = this.h;
   var arr = new Float32Array( w * h );
   var emptyRgn = new Uint8Array( w * h );
   var path = this.params.tailPath;
   if ( path == null || path.length < 3 ) return { falloff: arr, region: emptyRgn };
   var core = this.params.tailCore;
   var invInvCore = 1 / Math.max( 1e-9, 1 - core );


   var mask = rasterizePolygon( path, w, h );


   var useSoftEdges    = !!this.params.tailUseSoftEdges;
   var useFadeFromHead = !!this.params.tailUseFadeFromHead;


   // Neither gradient on → solid polygon (mask itself becomes the falloff).
   if ( !useSoftEdges && !useFadeFromHead )
   {
      Console.writeln( "    Tail: neither gradient is on — solid polygon." );
      pumpEvents();
      var nArr0 = arr.length;
      for ( var i = 0; i < nArr0; ++i )
         arr[i] = mask[i] ? 1 : 0;
      return { falloff: arr, region: mask };
   }


   // --- Hoisted axis math (needed by both branches when Fade from Head
   // is on; needed by Soft Edges to extend the DT input mask in the
   // combined case so head-edge feathering doesn't dim the head). ---
   var anchor = null;
   var axNx = 0, axNy = 0, axLen = 0, invMaxProj = 0;
   var tipIdx = -1;
   var fadeStart = 0, fadeAmount = 0, fadeSpan = 1;
   var fadeAxisOK = false;


   if ( useFadeFromHead )
   {
      anchor = this.params.tailAnchor;
      if ( anchor == null )
      {
         Console.warningln( "    Fade from Head: no anchor vertex — disabling for this run." );
         useFadeFromHead = false;
      }
   }
   if ( useFadeFromHead )
   {
      fadeStart  = (typeof this.params.tailFadeStart  == "number")
                   ? this.params.tailFadeStart  : 0;
      fadeAmount = (typeof this.params.tailFadeAmount == "number")
                   ? this.params.tailFadeAmount : 0;
      if ( fadeStart < 0 ) fadeStart = 0;
      if ( fadeStart > 1 ) fadeStart = 1;
      if ( fadeAmount < 0 ) fadeAmount = 0;
      if ( fadeAmount > 1 ) fadeAmount = 1;
      fadeSpan = Math.max( 1e-9, 1 - fadeStart );


      // Principal tail axis: anchor → polygon vertex farthest from anchor.
      var n = path.length;
      tipIdx = 0;
      var tipDistSq = -1;
      for ( var i = 0; i < n; ++i )
      {
         var dxi = path[i].x - anchor.x;
         var dyi = path[i].y - anchor.y;
         var dsq = dxi*dxi + dyi*dyi;
         if ( dsq > tipDistSq ) { tipDistSq = dsq; tipIdx = i; }
      }
      var tip = path[tipIdx];
      var axDx = tip.x - anchor.x;
      var axDy = tip.y - anchor.y;
      axLen = Math.sqrt( axDx*axDx + axDy*axDy );
      if ( axLen < 1e-6 )
      {
         Console.warningln( "    Fade from Head: degenerate axis — disabling for this run." );
         useFadeFromHead = false;
      }
      else
      {
         axNx = axDx / axLen;
         axNy = axDy / axLen;
         invMaxProj = 1 / axLen;
         fadeAxisOK = true;
         Console.writeln( "    Fade from Head: principal axis from anchor " +
            "to vertex #" + tipIdx + " (", axLen.toFixed(1), " px)." );
         pumpEvents();
      }
   }


   // Bail to solid if both ended up off after validation.
   if ( !useSoftEdges && !useFadeFromHead )
   {
      var nArr00 = arr.length;
      for ( var i = 0; i < nArr00; ++i )
         arr[i] = mask[i] ? 1 : 0;
      return { falloff: arr, region: mask };
   }


   var softTarget = useFadeFromHead ? new Float32Array( w * h ) : arr;
   var fadeTarget = useSoftEdges    ? new Float32Array( w * h ) : arr;


   if ( useSoftEdges )
   {
      // When BOTH gradients are on, we want:
      //   (a) Head edges shouldn't feather (so the head merges into the
      //       nucleus). Achieved by extending the DT input past the head
      //       (axial < 0) as "interior".
      //   (b) The tip's polygon-shape narrowing shouldn't pull Soft Edges
      //       to zero at the centerline (the user expects the tip's
      //       centerline to land at Fade amount). Achieved by extending
      //       the DT input past the tip (axial > 1) as "interior" too,
      //       AND by normalizing Soft Edges *per axial slice* — the max
      //       DT in each axial slice maps to softEdges = 1, so the
      //       centerline stays at 1 regardless of how narrow the polygon
      //       gets at that axial position.
      // The Soft Edges value is still written only into the ORIGINAL
      // polygon interior (mask == 1), so the output doesn't bleed past
      // the polygon shape.
      var dtMask = mask;
      var combinedMode = (useFadeFromHead && fadeAxisOK);
      if ( combinedMode )
      {
         Console.writeln( "    Soft Edges: extending DT mask past head and tip so only side edges feather…" );
         pumpEvents();
         dtMask = new Uint8Array( w * h );
         var stepM = progressInterval( h );
         for ( var y = 0; y < h; ++y )
         {
            var dyW0 = (y + 0.5) - anchor.y;
            var rowOff0 = y * w;
            for ( var x = 0; x < w; ++x )
            {
               if ( mask[rowOff0 + x] == 1 )
               {
                  dtMask[rowOff0 + x] = 1;
               }
               else
               {
                  var dxW0 = (x + 0.5) - anchor.x;
                  var ax0 = (dxW0 * axNx + dyW0 * axNy) * invMaxProj;
                  if ( ax0 < 0 || ax0 > 1 )
                     dtMask[rowOff0 + x] = 1;
               }
            }
            if ( y % stepM == 0 ) logProgress( "Soft Edges DT mask (rows)", y, h );
         }
         logProgress( "Soft Edges DT mask (rows)", h, h );
      }


      Console.writeln( "    Soft Edges: running distance transform…" );
      pumpEvents();
      var sqdt = squaredDistanceTransform( dtMask, w, h );


      if ( combinedMode )
      {
         // Per-axial-slice normalization. Each slice's max DT becomes
         // the reference for that slice — so along the centerline (which
         // always carries the slice's max) softEdges = 1 from head to tip.
         Console.writeln( "    Soft Edges: per-axial-slice max DT…" );
         pumpEvents();
         var numBins = 512;
         var sliceMax = new Float32Array( numBins );
         var stepB = progressInterval( h );
         for ( var y = 0; y < h; ++y )
         {
            var dyWB = (y + 0.5) - anchor.y;
            var rowOffB = y * w;
            for ( var x = 0; x < w; ++x )
            {
               var idxB = rowOffB + x;
               if ( mask[idxB] == 0 ) continue;
               var dxWB = (x + 0.5) - anchor.x;
               var axB = (dxWB * axNx + dyWB * axNy) * invMaxProj;
               var binB;
               if ( axB <= 0 ) binB = 0;
               else if ( axB >= 1 ) binB = numBins - 1;
               else binB = Math.floor( axB * numBins );
               if ( binB > numBins - 1 ) binB = numBins - 1;
               var sqB = sqdt[idxB];
               if ( sqB > sliceMax[binB] ) sliceMax[binB] = sqB;
            }
            if ( y % stepB == 0 ) logProgress( "Soft Edges per-slice max (rows)", y, h );
         }
         logProgress( "Soft Edges per-slice max (rows)", h, h );


         // Smooth sliceMax with a 5-bin running max so isolated low-pixel-
         // count bins don't blow up the normalization next to them.
         var smoothed = new Float32Array( numBins );
         for ( var b = 0; b < numBins; ++b )
         {
            var m = 0;
            var lo = b - 2, hi = b + 2;
            if ( lo < 0 ) lo = 0;
            if ( hi > numBins - 1 ) hi = numBins - 1;
            for ( var k = lo; k <= hi; ++k )
               if ( sliceMax[k] > m ) m = sliceMax[k];
            smoothed[b] = m;
         }
         sliceMax = smoothed;


         Console.writeln( "    Soft Edges: computing falloff with per-slice normalization…" );
         pumpEvents();
         var nArrP = arr.length;
         var stepP = progressInterval( h );
         for ( var y = 0; y < h; ++y )
         {
            var dyWP = (y + 0.5) - anchor.y;
            var rowOffP = y * w;
            for ( var x = 0; x < w; ++x )
            {
               var idxP = rowOffP + x;
               if ( mask[idxP] == 0 ) continue;
               var dxWP = (x + 0.5) - anchor.x;
               var axP = (dxWP * axNx + dyWP * axNy) * invMaxProj;
               var binP;
               if ( axP <= 0 ) binP = 0;
               else if ( axP >= 1 ) binP = numBins - 1;
               else binP = Math.floor( axP * numBins );
               if ( binP > numBins - 1 ) binP = numBins - 1;
               var sliceM = sliceMax[binP];
               if ( sliceM <= 0 ) { softTarget[idxP] = 0; continue; }
               var d = 1 - Math.sqrt( sqdt[idxP] / sliceM );
               if ( d < 0 ) d = 0;
               if ( d > 1 ) d = 1;
               var v;
               if ( d <= core ) v = 1;
               else if ( d >= 1 ) v = 0;
               else v = (1 - d) * invInvCore;
               softTarget[idxP] = v;
            }
            if ( y % stepP == 0 ) logProgress( "Soft Edges falloff (rows)", y, h );
         }
         logProgress( "Soft Edges falloff (rows)", h, h );
      }
      else
      {
         // Single-gradient case: normal global-max normalization.
         Console.writeln( "    Soft Edges: finding max distance over polygon interior…" );
         pumpEvents();
         var maxSq = 0;
         var nArrM = arr.length;
         for ( var i = 0; i < nArrM; ++i )
            if ( mask[i] == 1 && sqdt[i] > maxSq ) maxSq = sqdt[i];
         if ( maxSq > 0 )
         {
            var invMaxDist = 1 / Math.sqrt( maxSq );
            Console.writeln( "    Soft Edges: computing falloff for ",
               arr.length, " pixels…" );
            pumpEvents();
            var nArr = arr.length;
            var stepN = progressInterval( nArr );
            for ( var i = 0; i < nArr; ++i )
            {
               if ( mask[i] == 0 )
               {
                  if ( i % stepN == 0 && i > 0 )
                     logProgress( "Soft Edges falloff", i, nArr );
                  continue;
               }
               var d = 1 - Math.sqrt( sqdt[i] ) * invMaxDist;
               if ( d < 0 ) d = 0;
               var v;
               if ( d <= core ) v = 1;
               else if ( d >= 1 ) v = 0;
               else v = (1 - d) * invInvCore;
               softTarget[i] = v;
               if ( i % stepN == 0 && i > 0 )
                  logProgress( "Soft Edges falloff", i, nArr );
            }
            logProgress( "Soft Edges falloff", nArr, nArr );
         }
      }
   }


   if ( useFadeFromHead && fadeAxisOK )
   {
      var stepFade = progressInterval( h );
      for ( var y = 0; y < h; ++y )
      {
         var dyW = (y + 0.5) - anchor.y;
         var rowOff = y * w;
         for ( var x = 0; x < w; ++x )
         {
            if ( mask[rowOff + x] == 0 ) continue;
            var dxW = (x + 0.5) - anchor.x;
            var d = (dxW * axNx + dyW * axNy) * invMaxProj;
            if ( d < 0 ) d = 0;
            if ( d > 1 ) d = 1;
            var v;
            if ( d <= fadeStart ) v = 1;
            else if ( d >= 1 ) v = fadeAmount;
            else
            {
               var ratio = (d - fadeStart) / fadeSpan;
               v = 1 - (1 - fadeAmount) * ratio;
            }
            fadeTarget[rowOff + x] = v;
         }
         if ( y % stepFade == 0 ) logProgress( "Fade from Head (rows)", y, h );
      }
      logProgress( "Fade from Head (rows)", h, h );
   }


   // Combine if both gradients ran. Single gradient already lives in arr.
   if ( useSoftEdges && useFadeFromHead && fadeAxisOK )
   {
      Console.writeln( "    Tail: combining Soft Edges × Fade from Head." );
      pumpEvents();
      var nC = arr.length;
      for ( var i = 0; i < nC; ++i )
         arr[i] = (mask[i] == 0) ? 0 : softTarget[i] * fadeTarget[i];
   }


   return { falloff: arr, region: mask };
};


// Helper for run(): given the falloff F and its interior indicator R for
// one region, run the per-region Gaussian blur and apply the directional
// soften combine. Returns the final per-region float array. The 'split'
// case blurs F in place to avoid a copy in the common path.
CometMaskEngine.prototype.applyBlurAndDirection = function(
   F, R, sigma, direction, label )
{
   if ( sigma <= 0 ) return F;
   var w = this.w, h = this.h;
   if ( direction == 'split' )
   {
      Console.writeln( "<end><cbr>  → ", label, " blur σ=", sigma );
      gaussianBlurArray( F, w, h, sigma );
      return F;
   }
   Console.writeln( "<end><cbr>  → ", label, " blur σ=", sigma, " (", direction, ")" );
   var G = new Float32Array( F );
   gaussianBlurArray( G, w, h, sigma );
   return applySoftenDirection( F, G, R, direction );
};


// Combine the per-region falloff (F), its Gaussian-blurred copy (G), and
// its binary interior indicator (R) according to the soften direction:
//   inward  → output = G * R    (outer boundary stays sharp; interior
//                                gets the smoothed fall-off)
//   outward → output = max(F,G) (interior fall-off stays sharp; soft
//                                bleed extends past the boundary)
//   split   → output = G        (Gaussian both ways; current default)
function applySoftenDirection( F, G, R, direction )
{
   var n = F.length;
   var out = new Float32Array( n );
   if ( direction == 'inward' )
   {
      for ( var i = 0; i < n; ++i )
         out[i] = (R[i] == 1) ? G[i] : 0;
   }
   else if ( direction == 'outward' )
   {
      for ( var i = 0; i < n; ++i )
      {
         var f = F[i], g = G[i];
         out[i] = (f > g) ? f : g;
      }
   }
   else  // 'split'
   {
      for ( var i = 0; i < n; ++i ) out[i] = G[i];
   }
   return out;
}


CometMaskEngine.prototype.combine = function( a, b )
{
   var n = a.length;
   var out = new Float32Array( n );
   var mode = this.params.combineMode;
   if ( mode == 'screen' )
      for ( var i = 0; i < n; ++i ) out[i] = 1 - (1 - a[i]) * (1 - b[i]);
   else if ( mode == 'union' )
      for ( var i = 0; i < n; ++i ) out[i] = (a[i] > b[i]) ? a[i] : b[i];
   else if ( mode == 'additive' )
   {
      for ( var i = 0; i < n; ++i )
      {
         var s = a[i] + b[i];
         out[i] = (s > 1) ? 1 : s;
      }
   }
   else // 'intersection'
      for ( var i = 0; i < n; ++i ) out[i] = (a[i] < b[i]) ? a[i] : b[i];
   return out;
};


CometMaskEngine.prototype.computeLuminanceArray = function()
{
   var w = this.w, h = this.h;
   var img = this.srcView.image;
   if ( !img.isColor )
      return imageToArray( img );


   // Color: build R, G, B as separate Float32Arrays (one toMatrix per ch),
   // then combine per-pixel via Rec.709 luma.
   var arr = new Float32Array( w * h );
   var rArr = imageToArray_chan( img, 0 );
   var gArr = imageToArray_chan( img, 1 );
   var bArr = imageToArray_chan( img, 2 );
   for ( var i = 0; i < arr.length; ++i )
      arr[i] = 0.2126 * rArr[i] + 0.7152 * gArr[i] + 0.0722 * bArr[i];
   return arr;
};


// Per-channel bulk read for color sources. PJSR's image.toMatrix() returns
// channel 0 only; for color we need explicit per-channel access. The
// per-pixel sample() loop is slow on large color images — log progress.
function imageToArray_chan( image, ch )
{
   var w = image.width, h = image.height;
   var arr = new Float32Array( w * h );
   var step = progressInterval( h );
   for ( var y = 0; y < h; ++y )
   {
      for ( var x = 0; x < w; ++x )
         arr[y*w + x] = image.sample( x, y, ch );
      if ( y % step == 0 )
         logProgress( "luminance channel " + ch + " (rows)", y, h );
   }
   logProgress( "luminance channel " + ch + " (rows)", h, h );
   return arr;
}


// Write a Float32Array as a new 32-bit float single-channel ImageWindow
// with collision-safe ID. Returns the new window.
//
// We try the fast bulk-copy path (image.apply with ImageOp_Mov) first.
// Some PixInsight builds reject apply/assign on freshly-created
// ImageWindow images even inside beginProcess (the gaussianBlurArray
// call site succeeds, but emit calls have been observed to throw
// "read-only image"). On failure we fall back to a per-pixel setSample
// loop, which is slow on huge images but reliable.
CometMaskEngine.prototype.emitMask = function( arr, baseId )
{
   var w = this.w, h = this.h;
   var id = uniqueViewId( baseId );
   var win = new ImageWindow( w, h, 1, 32, true, false, id );
   var view = win.mainView;
   win.show();   // matches LinearPatternGeneration's pattern


   // Try the fast bulk path. On failure, the view becomes read-only for
   // the rest of this beginProcess block; we recover by endProcess and a
   // fresh beginProcess for the setSample fallback. See gaussianBlurArray
   // for the same pattern + rationale.
   try { gc(); } catch ( e ) {}
   var bulkOK = false;
   view.beginProcess( UndoFlag_NoSwapFile );
   try
   {
      var img = view.image;
      img.fill( 0 );
      img.apply( arrayToImage( arr, w, h ), ImageOp_Mov );
      bulkOK = true;
   }
   catch ( e1 )
   {
      Console.warningln( "<end><cbr>  → bulk write failed (",
         e1.toString(), "); recovering for per-pixel fallback..." );
   }
   view.endProcess();


   if ( !bulkOK )
   {
      try { gc(); } catch ( e ) {}
      view.beginProcess( UndoFlag_NoSwapFile );
      var img2 = view.image;
      img2.fill( 0 );
      var step = progressInterval( h );
      for ( var y = 0; y < h; ++y )
      {
         var rowOff = y * w;
         for ( var x = 0; x < w; ++x )
            img2.setSample( arr[rowOff + x], x, y, 0 );
         if ( y % step == 0 )
            logProgress( "emit setSample (rows)", y, h );
      }
      logProgress( "emit setSample (rows)", h, h );
      view.endProcess();
   }


   return win;
};


CometMaskEngine.prototype.run = function()
{
   var p = this.params;
   var w = this.w, h = this.h;


   if ( p.nucleus == null && (p.tailPath == null || p.tailPath.length < 3) )
      throw new Error( "No mask geometry: place a nucleus or build a "
                       + "≥3-vertex tail polygon first." );
   if ( p.outputPrimary == 'nucleus' && p.nucleus == null )
      throw new Error( "Primary output is 'Nucleus only' but no nucleus "
                       + "is defined." );
   if ( p.outputPrimary == 'tail' && (p.tailPath == null || p.tailPath.length < 3) )
      throw new Error( "Primary output is 'Tail only' but no tail "
                       + "polygon (≥3 vertices) is defined." );


   var t0 = (new Date).getTime();
   Console.writeln( "<end><cbr><br>", TITLE, " engine: ", w, "×", h, " pixels (",
      Math.round( w*h / 1e6 ), " megapixels)" );
   Console.writeln( "    Click the red Abort button on the Process Console " +
      "at any time to cancel." );
   Console.abortEnabled = true;
   pumpEvents();


   var ts = (new Date).getTime();
   Console.writeln( "<end><cbr>  → nucleus falloff" );
   pumpEvents();
   var nuc = this.computeNucleusFalloff();
   Console.writeln( "    nucleus falloff: ",
      ((new Date).getTime() - ts) / 1000, "s" );
   pumpEvents();


   ts = (new Date).getTime();
   var nucArr = this.applyBlurAndDirection(
      nuc.falloff, nuc.region, p.nucleusSigma, p.nucleusSoftenDirection,
      "nucleus" );
   Console.writeln( "    nucleus blur+direction: ",
      ((new Date).getTime() - ts) / 1000, "s" );
   pumpEvents();


   ts = (new Date).getTime();
   var tailLabel = "";
   if ( p.tailUseSoftEdges && p.tailUseFadeFromHead ) tailLabel = "soft+fade";
   else if ( p.tailUseSoftEdges ) tailLabel = "soft edges";
   else if ( p.tailUseFadeFromHead ) tailLabel = "fade from head";
   else tailLabel = "solid";
   Console.writeln( "<end><cbr>  → tail falloff (", tailLabel, ")" );
   pumpEvents();
   var tail = this.computeTailFalloff();
   Console.writeln( "    tail falloff: ",
      ((new Date).getTime() - ts) / 1000, "s" );
   pumpEvents();


   ts = (new Date).getTime();
   var tailArr = this.applyBlurAndDirection(
      tail.falloff, tail.region, p.tailSigma, p.tailSoftenDirection,
      "tail" );
   Console.writeln( "    tail blur+direction: ",
      ((new Date).getTime() - ts) / 1000, "s" );
   pumpEvents();


   // Build outputs list (primary first, then components if requested).
   var outputs = [];
   if ( p.outputPrimary == 'combined' )
   {
      ts = (new Date).getTime();
      Console.writeln( "<end><cbr>  → combine (", p.combineMode, ")" );
      pumpEvents();
      outputs.push( { arr: this.combine( nucArr, tailArr ),
                      suffix: '_cometmask' } );
      Console.writeln( "    combine: ", ((new Date).getTime() - ts) / 1000, "s" );
      pumpEvents();
   }
   else if ( p.outputPrimary == 'nucleus' )
      outputs.push( { arr: nucArr, suffix: '_cometmask_nucleus' } );
   else
      outputs.push( { arr: tailArr, suffix: '_cometmask_tail' } );


   if ( p.outputComponents )
   {
      var hasN = false, hasT = false;
      for ( var i = 0; i < outputs.length; ++i )
      {
         if ( outputs[i].suffix == '_cometmask_nucleus' ) hasN = true;
         if ( outputs[i].suffix == '_cometmask_tail' )    hasT = true;
      }
      if ( !hasN ) outputs.push( { arr: nucArr,  suffix: '_cometmask_nucleus' } );
      if ( !hasT ) outputs.push( { arr: tailArr, suffix: '_cometmask_tail' } );
   }


   if ( p.maskType == 'luminance' )
   {
      ts = (new Date).getTime();
      Console.writeln( "<end><cbr>  → luminance multiply" );
      pumpEvents();
      var lum = this.computeLuminanceArray();
      var stepLum = progressInterval( outputs.length );
      for ( var i = 0; i < outputs.length; ++i )
      {
         var a = outputs[i].arr;
         for ( var j = 0; j < a.length; ++j ) a[j] *= lum[j];
         pumpEvents();
      }
      Console.writeln( "    luminance multiply: ",
         ((new Date).getTime() - ts) / 1000, "s" );
      pumpEvents();


      // Gamma adjustment: out = in^(1/gamma). gamma == 1 is a no-op; >1
      // brightens midtones; <1 darkens. Only meaningful for the Luminance
      // mask type because the Binary mask is a pure geometric falloff
      // and gamma'ing it would just bend the linear ramp.
      var gamma = (typeof p.maskGamma == "number") ? p.maskGamma : 1.0;
      if ( Math.abs( gamma - 1.0 ) > 1e-6 && gamma > 0 )
      {
         ts = (new Date).getTime();
         Console.writeln( "<end><cbr>  → mask gamma=", gamma );
         pumpEvents();
         var invGamma = 1 / gamma;
         for ( var i = 0; i < outputs.length; ++i )
         {
            var a = outputs[i].arr;
            for ( var j = 0; j < a.length; ++j )
            {
               var v = a[j];
               a[j] = (v > 0) ? Math.pow( v, invGamma ) : 0;
            }
            pumpEvents();
         }
         Console.writeln( "    mask gamma: ",
            ((new Date).getTime() - ts) / 1000, "s" );
         pumpEvents();
      }
   }


   if ( p.outputInvert )
   {
      ts = (new Date).getTime();
      Console.writeln( "<end><cbr>  → invert" );
      pumpEvents();
      for ( var i = 0; i < outputs.length; ++i )
      {
         var a = outputs[i].arr;
         for ( var j = 0; j < a.length; ++j ) a[j] = 1 - a[j];
         pumpEvents();
      }
      Console.writeln( "    invert: ",
         ((new Date).getTime() - ts) / 1000, "s" );
      pumpEvents();
   }


   var emitted = [];
   for ( var i = 0; i < outputs.length; ++i )
   {
      ts = (new Date).getTime();
      Console.writeln( "<end><cbr>  → emit ", outputs[i].suffix );
      pumpEvents();
      var win = this.emitMask( outputs[i].arr, this.srcView.id + outputs[i].suffix );
      emitted.push( win.mainView.id );
      Console.writeln( "    emit: ",
         ((new Date).getTime() - ts) / 1000, "s" );
      pumpEvents();
   }


   var elapsed = ((new Date).getTime() - t0) / 1000;
   Console.writeln( "<end><cbr>", TITLE, " complete in ",
                    elapsed.toFixed(1), "s: ", emitted.join( ', ' ) );
   return emitted;
};


// ----------------------------------------------------------------------------
// CometMaskPreview — custom Frame subclass that paints a fit-to-canvas
// stretched bitmap. Future milestones add overlay drawing + mouse handling.
// ----------------------------------------------------------------------------


function CometMaskPreview( parent, srcView )
{
   this.__base__ = Frame;
   this.__base__( parent );


   this.frameStyle = FrameStyle_Sunken;
   this.setScaledMinSize( 480, 360 );


   this.srcView = srcView;
   this.imageWidth = srcView.image.width;
   this.imageHeight = srcView.image.height;


   // Auto-decide STF on dialog open: linear images need it (otherwise the
   // preview is near-black); stretched images don't (STF would just push
   // them brighter than they already are). The user can toggle either
   // way via the STF stretch checkbox.
   this.applyStfPreview = isLikelyLinear( srcView );
   Console.writeln( "<end><cbr>", TITLE, ": image median ",
      this.applyStfPreview ? "low — assuming linear, STF preview ON"
                           : "high — assuming stretched, STF preview OFF" );


   // Rebuild the cached source bitmap from the current applyStfPreview
   // setting. Called on initial construction and when the user toggles
   // the STF stretch checkbox.
   this.rebuildFullBitmap = function()
   {
      this.fullBitmap = this.applyStfPreview
         ? makeStretchedBitmap( this.srcView )
         : makeRawBitmap( this.srcView );
   };


   this.fullBitmap = null;
   this.rebuildFullBitmap();


   this.setApplyStfPreview = function( apply )
   {
      apply = !!apply;
      if ( this.applyStfPreview == apply ) return;
      this.applyStfPreview = apply;
      this.rebuildFullBitmap();
      this.refit();
      this.scrollbox.viewport.update();
   };


   // Cached fit + zoom state. fitScale is recomputed on viewport resize.
   // zoom is user-controlled (1.0 = fit). scale = fitScale * zoom is what
   // canvas↔image conversions and overlay paint use. offsetX/offsetY are
   // viewport-local coords of the (scaled) image's top-left, derived from
   // the scrollbox's scroll position whenever the image exceeds the
   // viewport, or centered when it doesn't.
   this.fitScale = 1.0;
   this.zoom = 1.0;
   this.scale = 1.0;
   this.offsetX = 0;
   this.offsetY = 0;
   this.scaledBitmap = null;


   this.toolMode = TOOL_IDLE;
   this.nucleus = null;
   this.tail = null;
   this.linkTailToNucleus = true;
   this.tailSmooth = 0.5;
   this.activeDrag = null;
   this.linkBaselineX = null;
   this.linkBaselineY = null;


   this.onNucleusChanged = null;
   this.onTailChanged = null;
   this.onToolModeChanged = null;
   this.onZoomChanged = null;
   this.onAutoDetectRequested = null;    // dialog assigns: function(imageX, imageY){...}


   var preview = this;


   // ScrollBox provides the scrollbars when the (zoomed) image exceeds
   // the viewport, plus the focused container that hosts our paint and
   // mouse handlers.
   this.scrollbox = new ScrollBox( this );
   this.scrollbox.autoScroll = true;
   this.scrollbox.tracking = true;
   this.scrollbox.viewport.cursor = new Cursor( StdCursor_Arrow );


   this.sizer = new HorizontalSizer;
   this.sizer.add( this.scrollbox );


   // Recompute offsetX/Y from the current scrollbox position. Called any
   // time the scroll position, viewport size, or scaled-bitmap size changes.
   this.refreshOffsets = function()
   {
      var sb = this.scrollbox;
      var vp = sb.viewport;
      if ( this.scaledBitmap == null )
      {
         this.offsetX = 0;
         this.offsetY = 0;
         return;
      }
      this.offsetX = (sb.maxHorizontalScrollPosition > 0)
         ? -sb.horizontalScrollPosition
         : Math.floor( (vp.width  - this.scaledBitmap.width)  / 2 );
      this.offsetY = (sb.maxVerticalScrollPosition > 0)
         ? -sb.verticalScrollPosition
         : Math.floor( (vp.height - this.scaledBitmap.height) / 2 );
   };


   this.rebuildScaledBitmap = function()
   {
      var interp = (this.scale < 1.0) ? BitmapInterpolation_Bilinear
                                      : BitmapInterpolation_NearestNeighbor;
      this.scaledBitmap = this.fullBitmap.scaled( this.scale, this.scale, interp );
   };


   this.updateScrollbarRange = function()
   {
      var vp = this.scrollbox.viewport;
      this.scrollbox.maxHorizontalScrollPosition =
         Math.max( 0, this.scaledBitmap.width  - vp.width  );
      this.scrollbox.maxVerticalScrollPosition =
         Math.max( 0, this.scaledBitmap.height - vp.height );
   };


   this.refit = function()
   {
      var vp = this.scrollbox.viewport;
      if ( vp.width < 4 || vp.height < 4 ) return;
      var sx = vp.width  / this.imageWidth;
      var sy = vp.height / this.imageHeight;
      this.fitScale = Math.min( sx, sy );
      this.scale = this.fitScale * this.zoom;
      this.rebuildScaledBitmap();
      this.updateScrollbarRange();
      this.refreshOffsets();
      // refit() runs on viewport resize, so fitScale (and hence scale)
      // changes — notify the dialog so the % label tracks.
      if ( this.onZoomChanged ) this.onZoomChanged( this.scale );
   };


   // Internal: apply a zoom level (no clamping) preserving the image-space
   // point at (focalCanvasX, focalCanvasY).
   this._applyZoom = function( newZoom, focalCanvasX, focalCanvasY )
   {
      if ( Math.abs( newZoom - this.zoom ) < 1e-6 ) return;
      var vp = this.scrollbox.viewport;
      if ( focalCanvasX == null ) focalCanvasX = vp.width  / 2;
      if ( focalCanvasY == null ) focalCanvasY = vp.height / 2;


      var imgX = (focalCanvasX - this.offsetX) / this.scale;
      var imgY = (focalCanvasY - this.offsetY) / this.scale;
      this.zoom = newZoom;
      this.scale = this.fitScale * this.zoom;
      this.rebuildScaledBitmap();
      this.updateScrollbarRange();


      var sb = this.scrollbox;
      sb.horizontalScrollPosition = Math.max( 0, Math.min(
         sb.maxHorizontalScrollPosition, imgX * this.scale - focalCanvasX ) );
      sb.verticalScrollPosition = Math.max( 0, Math.min(
         sb.maxVerticalScrollPosition, imgY * this.scale - focalCanvasY ) );
      this.refreshOffsets();


      // The onZoomChanged callback receives the effective scale (image →
      // canvas pixel ratio), not the user's "zoom multiplier", so the
      // dialog's percentage label can read "100%" exactly at 1:1 pixel
      // size and "13%" at fit on a large image.
      if ( this.onZoomChanged ) this.onZoomChanged( this.scale );
      this.scrollbox.viewport.update();
   };


   // Zoom centered on the given viewport-local focal point (defaults to
   // viewport center). Maintains the image-space point under the focal
   // by adjusting scrollbox positions. Clamped to [1, 16].
   this.setZoom = function( newZoom, focalCanvasX, focalCanvasY )
   {
      newZoom = Math.max( 1.0, Math.min( 16.0, newZoom ) );
      this._applyZoom( newZoom, focalCanvasX, focalCanvasY );
   };


   // Zoom to actual pixel size (scale = 1.0). Bypasses the lower zoom
   // clamp so this works on small images too — the result is
   // 1 image pixel == 1 viewport pixel regardless of fit scale.
   this.setZoomToActualSize = function( focalCanvasX, focalCanvasY )
   {
      if ( this.fitScale < 1e-9 ) return;
      this._applyZoom( 1.0 / this.fitScale, focalCanvasX, focalCanvasY );
   };


   this.resetZoom = function()
   {
      if ( this.zoom == 1.0 ) return;
      this.zoom = 1.0;
      this.scrollbox.horizontalScrollPosition = 0;
      this.scrollbox.verticalScrollPosition = 0;
      this.refit();
      if ( this.onZoomChanged ) this.onZoomChanged( this.scale );
      this.scrollbox.viewport.update();
   };


   // Scrollbar drag → repaint with new offsets.
   this.scrollbox.onHorizontalScrollPosUpdated = function( newPos )
   {
      preview.refreshOffsets();
      this.viewport.update();
   };
   this.scrollbox.onVerticalScrollPosUpdated = function( newPos )
   {
      preview.refreshOffsets();
      this.viewport.update();
   };


   this.scrollbox.viewport.onResize = function( wNew, hNew, wOld, hOld )
   {
      preview.refit();
      this.update();
   };


   this.scrollbox.viewport.onPaint = function( x0, y0, x1, y1 )
   {
      var g = new Graphics( this );
      try
      {
         g.fillRect( x0, y0, x1, y1, new Brush( 0xff202020 ) );


         if ( preview.scaledBitmap != null )
         {
            g.drawBitmap( preview.offsetX, preview.offsetY, preview.scaledBitmap );


            g.pen = new Pen( 0xff606060, 1 );
            g.drawRect( preview.offsetX - 1,
                        preview.offsetY - 1,
                        preview.offsetX + preview.scaledBitmap.width,
                        preview.offsetY + preview.scaledBitmap.height );
         }


         g.antialiasing = true;
         if ( preview.tail != null )
            preview.paintTail( g );
         if ( preview.nucleus != null )
            preview.paintNucleus( g );
      }
      finally
      {
         g.end();
      }
   };


   this.scrollbox.viewport.onMouseWheel = function( x, y, delta, buttonState, modifiers )
   {
      // Positive delta = zoom out (matches PJSR PreviewControl).
      var step = (delta > 0) ? (1/1.25) : 1.25;
      preview.setZoom( preview.zoom * step, x, y );
   };


   // Convert canvas-local (x,y) to source-image pixel coordinates. Returns
   // null if the point is outside the rendered image rect.
   this.canvasToImage = function( x, y )
   {
      if ( this.scaledBitmap == null )
         return null;
      var ix = (x - this.offsetX) / this.scale;
      var iy = (y - this.offsetY) / this.scale;
      if ( ix < 0 || iy < 0 || ix > this.imageWidth || iy > this.imageHeight )
         return null;
      return new Point( ix, iy );
   };


   // Same conversion but clamped to image bounds; used during drag so the
   // user can pull a handle past the canvas edge without losing it.
   this.canvasToImageClamped = function( x, y )
   {
      var ix = Math.max( 0, Math.min( this.imageWidth,  (x - this.offsetX) / this.scale ) );
      var iy = Math.max( 0, Math.min( this.imageHeight, (y - this.offsetY) / this.scale ) );
      return new Point( ix, iy );
   };


   // Default radius for a freshly placed nucleus: ~3% of the smaller image
   // dimension, clamped to a sane range.
   this.defaultNucleusRadius = function()
   {
      var r = Math.min( this.imageWidth, this.imageHeight ) * 0.03;
      return Math.max( 10, Math.min( 200, Math.round( r ) ) );
   };


   // Returns 'center' | 'rimX' | 'rimY' | null based on canvas-pixel proximity
   // to the nucleus handles. The +X handle sits at the end of the rotated
   // major axis; the +Y handle at the rotated minor axis (theta + 90°).
   this.hitTestNucleus = function( cx, cy )
   {
      if ( this.nucleus == null )
         return null;
      var n = this.nucleus;
      var theta = n.theta || 0;
      var cosT = Math.cos( theta );
      var sinT = Math.sin( theta );


      var ccx = this.offsetX + n.x * this.scale;
      var ccy = this.offsetY + n.y * this.scale;
      // +X handle = center + Rx * (cos theta, sin theta)
      var rxx = this.offsetX + (n.x + n.Rx * cosT) * this.scale;
      var rxy = this.offsetY + (n.y + n.Rx * sinT) * this.scale;
      // +Y handle = center + Ry * (-sin theta, cos theta)
      var ryx = this.offsetX + (n.x - n.Ry * sinT) * this.scale;
      var ryy = this.offsetY + (n.y + n.Ry * cosT) * this.scale;


      function dist( ax, ay, bx, by )
      {
         var dx = ax - bx, dy = ay - by;
         return Math.sqrt( dx*dx + dy*dy );
      }


      // Rim handles take priority over center so a small ellipse with
      // overlapping handles is still resizeable.
      if ( dist( cx, cy, rxx, rxy ) <= HANDLE_HIT_RADIUS ) return 'rimX';
      if ( dist( cx, cy, ryx, ryy ) <= HANDLE_HIT_RADIUS ) return 'rimY';
      if ( dist( cx, cy, ccx, ccy ) <= HANDLE_HIT_RADIUS ) return 'center';
      return null;
   };


   this.paintNucleus = function( g )
   {
      var n = this.nucleus;
      var theta = n.theta || 0;
      var cosT = Math.cos( theta );
      var sinT = Math.sin( theta );


      var ccx = this.offsetX + n.x * this.scale;
      var ccy = this.offsetY + n.y * this.scale;
      var rx = n.Rx * this.scale;
      var ry = n.Ry * this.scale;


      // Sample the rotated ellipse perimeter as a closed polyline. PJSR
      // Graphics.drawEllipse only draws axis-aligned ellipses, so we
      // rasterize the curve ourselves. 64 samples gives a smooth outline
      // even at high zoom for typical sizes.
      var samples = 64;
      var pts = [];
      for ( var i = 0; i <= samples; ++i )
      {
         var phi = (i / samples) * 2 * Math.PI;
         var lx = rx * Math.cos( phi );
         var ly = ry * Math.sin( phi );
         var px = ccx + lx * cosT - ly * sinT;
         var py = ccy + lx * sinT + ly * cosT;
         pts.push( new Point( px, py ) );
      }
      g.pen = new Pen( COLOR_NUCLEUS_OUTLINE, 1.5 );
      g.brush = new Brush( 0 );
      g.drawPolyline( pts );


      // Cross at the center along the rotated axes — gives the user a
      // clear cue about which way the ellipse is oriented when theta != 0.
      g.pen = new Pen( COLOR_NUCLEUS_OUTLINE, 1 );
      var crossLen = 8;
      g.drawLine( ccx - crossLen * cosT, ccy - crossLen * sinT,
                  ccx + crossLen * cosT, ccy + crossLen * sinT );
      g.drawLine( ccx + crossLen * sinT, ccy - crossLen * cosT,
                  ccx - crossLen * sinT, ccy + crossLen * cosT );


      // Handles at the rotated rim ends.
      var rxhx = ccx + rx * cosT;
      var rxhy = ccy + rx * sinT;
      var ryhx = ccx - ry * sinT;
      var ryhy = ccy + ry * cosT;
      var handles = [
         { x: ccx,  y: ccy,  fill: COLOR_HANDLE_CENTER },
         { x: rxhx, y: rxhy, fill: COLOR_HANDLE_RIM    },
         { x: ryhx, y: ryhy, fill: COLOR_HANDLE_RIM    }
      ];
      for ( var i = 0; i < handles.length; ++i )
      {
         var h = handles[i];
         g.pen = new Pen( COLOR_HANDLE_OUTLINE, 1 );
         g.brush = new Brush( h.fill );
         g.drawEllipse( h.x - HANDLE_DRAW_RADIUS, h.y - HANDLE_DRAW_RADIUS,
                        h.x + HANDLE_DRAW_RADIUS, h.y + HANDLE_DRAW_RADIUS );
      }
   };


   // ---- Tail polygon helpers --------------------------------------------


   // While link is on, the tail moves as a rigid body whenever the nucleus
   // moves. We track the last-seen nucleus position as a baseline; on each
   // nucleus mutation we translate every tail vertex by the delta. Cheap
   // to call after any nucleus mutation; no-op when link is off.
   this.enforceAnchorLink = function()
   {
      if ( !this.linkTailToNucleus ) return;
      if ( this.nucleus == null ) return;


      if ( this.linkBaselineX != null && this.tail != null )
      {
         var dx = this.nucleus.x - this.linkBaselineX;
         var dy = this.nucleus.y - this.linkBaselineY;
         if ( dx != 0 || dy != 0 )
         {
            for ( var i = 0; i < this.tail.vertices.length; ++i )
            {
               this.tail.vertices[i].x += dx;
               this.tail.vertices[i].y += dy;
            }
            this._notifyTailChanged();
         }
      }


      this.linkBaselineX = this.nucleus.x;
      this.linkBaselineY = this.nucleus.y;
   };


   // Single entry point for changing the link state. Manages the baseline
   // so the next nucleus mutation translates by zero (not by however far
   // the nucleus drifted while the link was off).
   this.setLinkTailToNucleus = function( linked )
   {
      this.linkTailToNucleus = linked;
      if ( linked && this.nucleus != null )
      {
         this.linkBaselineX = this.nucleus.x;
         this.linkBaselineY = this.nucleus.y;
      }
      else
      {
         this.linkBaselineX = null;
         this.linkBaselineY = null;
      }
   };


   // Returns an array of source-image-space Points approximating the tail
   // outline. With tailSmooth == 0 this is just the polygon vertices in
   // order (closed by repeating vertex 0). With tailSmooth > 0 each
   // polygon edge is replaced with a sampled cubic Bezier whose control
   // points come from the Catmull-Rom-to-Bezier conversion (closed
   // polygon: indices wrap modulo n).
   this.sampleSmoothPath = function()
   {
      if ( this.tail == null ) return [];
      var verts = this.tail.vertices;
      var n = verts.length;
      if ( n == 0 ) return [];
      if ( n == 1 ) return [ new Point( verts[0].x, verts[0].y ) ];
      if ( n == 2 ) return [
         new Point( verts[0].x, verts[0].y ),
         new Point( verts[1].x, verts[1].y ) ];


      var smooth = this.tailSmooth;
      var s = smooth / 6.0;
      var samplesPerSegment = (smooth > 0) ? 16 : 1;


      var path = [];
      for ( var i = 0; i < n; ++i )
      {
         var p0 = verts[(i - 1 + n) % n];
         var p1 = verts[i];
         var p2 = verts[(i + 1) % n];
         var p3 = verts[(i + 2) % n];


         var b1x = p1.x + (p2.x - p0.x) * s;
         var b1y = p1.y + (p2.y - p0.y) * s;
         var b2x = p2.x - (p3.x - p1.x) * s;
         var b2y = p2.y - (p3.y - p1.y) * s;


         for ( var k = 0; k < samplesPerSegment; ++k )
         {
            var t = k / samplesPerSegment;
            var u = 1 - t;
            var x = u*u*u * p1.x + 3*u*u*t * b1x + 3*u*t*t * b2x + t*t*t * p2.x;
            var y = u*u*u * p1.y + 3*u*u*t * b1y + 3*u*t*t * b2y + t*t*t * p2.y;
            path.push( new Point( x, y ) );
         }
      }
      // Close the loop visually by appending the start point.
      path.push( new Point( verts[0].x, verts[0].y ) );
      return path;
   };


   // Called when entering Add Tail Mask mode. If link is on, nucleus
   // exists, and tail has no vertices yet, seed an anchored first vertex
   // at the nucleus center so the user can immediately start adding more.
   this.ensureTailAnchorIfLinked = function()
   {
      if ( !this.linkTailToNucleus ) return;
      if ( this.nucleus == null ) return;
      if ( this.tail != null && this.tail.vertices.length > 0 ) return;
      this.tail = {
         vertices: [ new Point( this.nucleus.x, this.nucleus.y ) ],
         anchorIndex: 0
      };
      this._notifyTailChanged();
   };


   // Returns { kind: 'vertex', index: i } if a vertex handle is hit.
   this.hitTestTail = function( cx, cy )
   {
      if ( this.tail == null ) return null;
      var verts = this.tail.vertices;
      for ( var i = 0; i < verts.length; ++i )
      {
         var vcx = this.offsetX + verts[i].x * this.scale;
         var vcy = this.offsetY + verts[i].y * this.scale;
         var dx = cx - vcx, dy = cy - vcy;
         if ( Math.sqrt( dx*dx + dy*dy ) <= HANDLE_HIT_RADIUS )
            return { kind: 'vertex', index: i };
      }
      return null;
   };


   // For a click near a polygon edge but not on a vertex, returns
   // { edgeIndex: i, point: Point } indicating where to insert. The new
   // vertex goes at index (edgeIndex + 1).
   this.hitTestEdge = function( cx, cy )
   {
      if ( this.tail == null ) return null;
      var verts = this.tail.vertices;
      var n = verts.length;
      if ( n < 2 ) return null;


      // Skip the closing edge for n==2 (it overlaps the only real edge).
      var edgeCount = (n == 2) ? 1 : n;


      var best = null;
      for ( var i = 0; i < edgeCount; ++i )
      {
         var a = verts[i];
         var b = verts[(i + 1) % n];
         var acx = this.offsetX + a.x * this.scale;
         var acy = this.offsetY + a.y * this.scale;
         var bcx = this.offsetX + b.x * this.scale;
         var bcy = this.offsetY + b.y * this.scale;
         var dx = bcx - acx, dy = bcy - acy;
         var lenSq = dx*dx + dy*dy;
         if ( lenSq < 1e-6 ) continue;
         var t = ((cx - acx) * dx + (cy - acy) * dy) / lenSq;
         if ( t < 0 ) t = 0;
         if ( t > 1 ) t = 1;
         var px = acx + t * dx;
         var py = acy + t * dy;
         var ddx = cx - px, ddy = cy - py;
         var d = Math.sqrt( ddx*ddx + ddy*ddy );
         if ( d <= EDGE_HIT_RADIUS && (best == null || d < best.dist) )
         {
            // Image-space insertion point along the original segment.
            var ix = a.x + t * (b.x - a.x);
            var iy = a.y + t * (b.y - a.y);
            best = { edgeIndex: i, point: new Point( ix, iy ), dist: d };
         }
      }
      return best;
   };


   this.paintTail = function( g )
   {
      if ( this.tail == null ) return;
      var verts = this.tail.vertices;
      var n = verts.length;
      if ( n == 0 ) return;


      // Edges: smoothed when tailSmooth > 0, polygon otherwise. Both flow
      // through sampleSmoothPath() so the rendering path is uniform.
      var path = this.sampleSmoothPath();
      if ( path.length >= 2 )
      {
         var canvasPath = [];
         for ( var i = 0; i < path.length; ++i )
            canvasPath.push( new Point(
               this.offsetX + path[i].x * this.scale,
               this.offsetY + path[i].y * this.scale ) );


         g.pen = new Pen( COLOR_TAIL_OUTLINE, 1.5 );
         g.brush = new Brush( 0 );
         g.drawPolyline( canvasPath );
      }


      // Vertex handles. Anchor vertex shows yellow when linked, white when
      // free; non-anchor vertices are always white.
      for ( var i = 0; i < n; ++i )
      {
         var v = verts[i];
         var vx = this.offsetX + v.x * this.scale;
         var vy = this.offsetY + v.y * this.scale;
         var isAnchor = (i == this.tail.anchorIndex);
         var fill;
         if ( isAnchor && this.linkTailToNucleus )
            fill = COLOR_TAIL_ANCHOR_LINKED;
         else if ( isAnchor )
            fill = COLOR_TAIL_ANCHOR_FREE;
         else
            fill = COLOR_TAIL_VERTEX;
         g.pen = new Pen( COLOR_HANDLE_OUTLINE, 1 );
         g.brush = new Brush( fill );
         g.drawEllipse( vx - HANDLE_DRAW_RADIUS, vy - HANDLE_DRAW_RADIUS,
                        vx + HANDLE_DRAW_RADIUS, vy + HANDLE_DRAW_RADIUS );
      }
   };


   // Returns true on success. Refuses if it would leave fewer than 3
   // vertices, or if deleting the linked anchor.
   this.tryDeleteTailVertex = function( index )
   {
      if ( this.tail == null ) return false;
      if ( this.tail.vertices.length <= 3 ) return false;
      if ( this.linkTailToNucleus && index == this.tail.anchorIndex ) return false;


      this.tail.vertices.splice( index, 1 );
      if ( this.tail.anchorIndex > index )
         --this.tail.anchorIndex;
      else if ( this.tail.anchorIndex >= this.tail.vertices.length )
         this.tail.anchorIndex = 0;
      this._notifyTailChanged();
      this.scrollbox.viewport.update();
      return true;
   };


   // Centralized notification helpers. enforceAnchorLink runs every time
   // the nucleus moves, so the linked anchor vertex follows it.
   this._notifyNucleusChanged = function()
   {
      this.enforceAnchorLink();
      if ( this.onNucleusChanged ) this.onNucleusChanged();
   };
   this._notifyTailChanged = function()
   {
      if ( this.onTailChanged ) this.onTailChanged();
   };


   this.scrollbox.viewport.onMousePress = function( x, y, button, buttonState, modifiers )
   {
      // ---- Middle-button drag → pan the scrollbox in any tool mode ----
      if ( button == MouseButton_Middle )
      {
         preview.activeDrag = {
            kind: 'pan',
            startX: x,
            startY: y,
            startScrollX: preview.scrollbox.horizontalScrollPosition,
            startScrollY: preview.scrollbox.verticalScrollPosition
         };
         this.cursor = new Cursor( StdCursor_ClosedHand );
         return;
      }


      // ---- Auto Detect Comet (left-click only). Delegates to the
      //      dialog so the confirm-and-run logic stays in one place. ----
      if ( preview.toolMode == TOOL_AUTO_DETECT )
      {
         if ( button != MouseButton_Left ) return;
         var p = preview.canvasToImage( x, y );
         if ( p == null ) return;
         if ( preview.onAutoDetectRequested )
            preview.onAutoDetectRequested( p.x, p.y );
         return;
      }


      // ---- Place Nucleus mode (left-click only) ----
      if ( preview.toolMode == TOOL_PLACE_NUCLEUS )
      {
         if ( button != MouseButton_Left ) return;
         var p = preview.canvasToImage( x, y );
         if ( p == null ) return;


         if ( preview.nucleus == null )
         {
            var r = preview.defaultNucleusRadius();
            preview.nucleus = { x: p.x, y: p.y, Rx: r, Ry: r, theta: 0 };
         }
         else
         {
            preview.nucleus.x = p.x;
            preview.nucleus.y = p.y;
            // Re-place preserves Rx/Ry/theta, only the center moves.
         }


         preview._notifyNucleusChanged();
         // After placing the nucleus, walk the user into the next workflow
         // step: building the tail polygon. The anchor vertex is seeded at
         // the nucleus center on entry to Add Tail Mask (when link is on),
         // so the first user click should already be the second polygon
         // point. If a tail already exists, the user is re-positioning the
         // nucleus mid-workflow — drop them in Edit Points instead.
         var hasTail = (preview.tail != null && preview.tail.vertices.length > 0);
         var next = hasTail ? TOOL_IDLE : TOOL_ADD_TAIL_VERTEX;
         if ( preview.onToolModeChanged ) preview.onToolModeChanged( next );
         this.update();
         return;
      }


      // ---- Add Tail Mask mode (left-click only; mode stays active) ----
      if ( preview.toolMode == TOOL_ADD_TAIL_VERTEX )
      {
         if ( button != MouseButton_Left ) return;
         var p = preview.canvasToImage( x, y );
         if ( p == null ) return;


         if ( preview.tail == null )
            preview.tail = { vertices: [], anchorIndex: 0 };
         preview.tail.vertices.push( new Point( p.x, p.y ) );
         preview._notifyTailChanged();
         this.update();
         return;
      }


      // ---- Idle mode ----
      if ( preview.toolMode == TOOL_IDLE )
      {
         // Right-click → delete a tail vertex if hit.
         if ( button == MouseButton_Right )
         {
            var th = preview.hitTestTail( x, y );
            if ( th != null && th.kind == 'vertex' )
               preview.tryDeleteTailVertex( th.index );
            return;
         }


         if ( button != MouseButton_Left ) return;


         var nh = preview.hitTestNucleus( x, y );
         if ( nh != null )
         {
            preview.activeDrag = {
               kind: nh,
               initialRx: preview.nucleus.Rx,
               initialRy: preview.nucleus.Ry
            };
            this.cursor = new Cursor( StdCursor_ClosedHand );
            return;
         }


         var th = preview.hitTestTail( x, y );
         if ( th != null && th.kind == 'vertex' )
         {
            if ( preview.linkTailToNucleus && th.index == preview.tail.anchorIndex )
               return;
            preview.activeDrag = { kind: 'tailVertex', index: th.index };
            this.cursor = new Cursor( StdCursor_ClosedHand );
            return;
         }


         var eh = preview.hitTestEdge( x, y );
         if ( eh != null )
         {
            preview.tail.vertices.splice( eh.edgeIndex + 1, 0, eh.point );
            if ( preview.tail.anchorIndex > eh.edgeIndex )
               ++preview.tail.anchorIndex;
            preview._notifyTailChanged();
            this.update();
            return;
         }
      }
   };


   this.scrollbox.viewport.onMouseMove = function( x, y, buttonState, modifiers )
   {
      if ( preview.activeDrag == null )
         return;


      // ---- Pan via scrollbox positions ----
      if ( preview.activeDrag.kind == 'pan' )
      {
         var dx = x - preview.activeDrag.startX;
         var dy = y - preview.activeDrag.startY;
         var sb = preview.scrollbox;
         sb.horizontalScrollPosition = Math.max( 0, Math.min(
            sb.maxHorizontalScrollPosition,
            preview.activeDrag.startScrollX - dx ) );
         sb.verticalScrollPosition = Math.max( 0, Math.min(
            sb.maxVerticalScrollPosition,
            preview.activeDrag.startScrollY - dy ) );
         // refreshOffsets + viewport.update happen via the scrollbox's
         // onScrollPosUpdated callbacks.
         return;
      }


      var p = preview.canvasToImageClamped( x, y );
      var shift = (modifiers & KeyModifier_Shift) != 0;


      if ( preview.activeDrag.kind == 'tailVertex' )
      {
         var v = preview.tail.vertices[preview.activeDrag.index];
         v.x = p.x;
         v.y = p.y;
         preview._notifyTailChanged();
         this.update();
         return;
      }


      var n = preview.nucleus;
      if ( preview.activeDrag.kind == 'center' )
      {
         n.x = p.x;
         n.y = p.y;
      }
      else if ( preview.activeDrag.kind == 'rimX' )
      {
         // Rim handles act as "axis-end grips": dragging redefines that
         // axis's direction (rotation) and length. The +X handle position
         // becomes the new (cos θ, sin θ) · Rx vector. Free drag = resize
         // and rotate together; Shift additionally preserves the Ry/Rx
         // ratio captured at drag-start.
         var dx = p.x - n.x;
         var dy = p.y - n.y;
         var newRx = Math.max( 1, Math.sqrt( dx*dx + dy*dy ) );
         n.Rx = newRx;
         n.theta = Math.atan2( dy, dx );
         if ( shift && preview.activeDrag.initialRx > 0 )
         {
            var ratio = preview.activeDrag.initialRy / preview.activeDrag.initialRx;
            n.Ry = Math.max( 1, newRx * ratio );
         }
      }
      else if ( preview.activeDrag.kind == 'rimY' )
      {
         var dx = p.x - n.x;
         var dy = p.y - n.y;
         var newRy = Math.max( 1, Math.sqrt( dx*dx + dy*dy ) );
         n.Ry = newRy;
         // +Y axis sits at theta + 90°, so theta = (angle to handle) − 90°.
         n.theta = Math.atan2( dy, dx ) - Math.PI / 2;
         if ( shift && preview.activeDrag.initialRy > 0 )
         {
            var ratio = preview.activeDrag.initialRx / preview.activeDrag.initialRy;
            n.Rx = Math.max( 1, newRy * ratio );
         }
      }


      preview._notifyNucleusChanged();
      this.update();
   };


   this.scrollbox.viewport.onMouseRelease = function( x, y, button, buttonState, modifiers )
   {
      if ( preview.activeDrag != null )
      {
         preview.activeDrag = null;
         this.cursor = new Cursor( cursorForToolMode( preview.toolMode ) );
      }
   };
}


CometMaskPreview.prototype = new Frame;


// ----------------------------------------------------------------------------
// InstructionsDialog — modeless help window with a scrolling read-only
// TextBox of basic-usage steps. Kept separate from CometMaskDialog so the
// main panel stays uncluttered. Opened from the "Instructions" button at
// the top of the right-side panel column.
// ----------------------------------------------------------------------------


function InstructionsDialog( parent )
{
   this.__base__ = Dialog;
   this.__base__();


   this.windowTitle = TITLE + " — Instructions";


   var lines = [];
   lines.push( "Basic usage" );
   lines.push( "" );
   lines.push( "Image prep" );
   lines.push( "  • Works on linear or non-linear images, but produces the best mask on a non-linear starless comet-only image." );
   lines.push( "" );
   lines.push( "1. Place the nucleus" );
   lines.push( "  • Place Nucleus is the default tool when the dialog opens." );
   lines.push( "  • Click on the center of the comet's nucleus." );
   lines.push( "  • An ellipse appears with handles. Drag a rim handle to resize AND rotate (the handle defines the axis end)." );
   lines.push( "  • Hold Shift while dragging a rim handle to preserve the ellipse's current shape (proportional scaling)." );
   lines.push( "" );
   lines.push( "2. Add the tail mask" );
   lines.push( "  • After placing the nucleus, the tool switches to Add Tail Mask automatically." );
   lines.push( "  • The first tail point is already seeded at the nucleus center (anchor), so your first click should be the next point out along the tail — usually just inside the nucleus radius." );
   lines.push( "  • Keep clicking to outline the tail. Don't worry about perfection — you can refine later." );
   lines.push( "" );
   lines.push( "3. Refine in Edit Points" );
   lines.push( "  • Switch to Edit Points to fine-tune." );
   lines.push( "  • Click-drag any handle to move it (nucleus center, nucleus rim, tail corners)." );
   lines.push( "  • Click on a tail edge between two corners to insert a new corner there." );
   lines.push( "  • Right-click a tail corner to delete it (3-corner minimum)." );
   lines.push( "  • Click-and-drag the nucleus center handle to move both masks together (the tail polygon rigid-translates with it), so you can reposition the whole comet mask at once." );
   lines.push( "" );
   lines.push( "4. Output options" );
   lines.push( "  • Choose what to output: the combined mask, the individual nucleus and tail components, or both at the same time." );
   lines.push( "  • Choose mask type: Binary (the geometric mask) or Luminance (geometric mask × source brightness, with a gamma slider)." );
   lines.push( "  • Optionally invert the mask." );
   lines.push( "" );
   lines.push( "5. Adjust softness and other settings" );
   lines.push( "  • The nucleus and tail have their OWN, independent softness controls — each lives in its own panel (Nucleus / Tail) on the right side. Adjusting the nucleus sliders does not affect the tail, and vice versa." );
   lines.push( "  • Core fraction (per region) controls how far the solid-1 center extends before the linear falloff begins. Set it independently for the nucleus and the tail." );
   lines.push( "  • Soften σ (px) (per region) adds a Gaussian blur to that region. Soften direction (Inward / Outward / Split, per region) controls which side of the boundary the blur acts on." );
   lines.push( "  • Combine mode (Screen / Union / Additive / Intersection) controls how the (already-independently-tuned) nucleus and tail masks merge into the final combined output." );
   lines.push( "" );
   lines.push( "6. Fade the tail (optional)" );
   lines.push( "  • Enable Fade from Head on the Tail panel to make the tail brightness fall off from the comet's head out to the tip." );
   lines.push( "  • Use Fade start (%) to choose where the ramp begins along the tail axis, and Fade amount (%) to choose how dark the tip gets (0% = no fade, 100% = full fade to black)." );
   lines.push( "  • Useful for softly fading the end of a long comet tail." );
   lines.push( "" );
   lines.push( "7. Create the mask" );
   lines.push( "  • Click Create Mask to render the mask image(s) into new ImageWindows." );
   lines.push( "  • The dialog stays open — evaluate the result, adjust geometry / sliders / options, and click Create Mask again to audition and fine-tune as many iterations as you like." );
   lines.push( "  • Done closes the dialog without creating a mask." );
   lines.push( "" );
   lines.push( "Navigation" );
   lines.push( "  • Mouse wheel zooms the preview centered on the cursor." );
   lines.push( "  • The −, +, Fit, and 100% buttons under the preview canvas control zoom directly." );
   lines.push( "  • Middle-mouse-button drag pans the preview (scrollbars also appear when the image overflows the viewport)." );
   lines.push( "" );
   lines.push( "Auto Detect Comet (EXPERIMENTAL)" );
   lines.push( "  • One-click shortcut. Select Auto Detect Comet and click on the brightest part of the comet head." );
   lines.push( "  • The script flood-fills bright pixels, fits a nucleus ellipse anchored at your click, and builds a tail polygon from the flood region's convex hull." );
   lines.push( "  • Results vary by comet morphology, exposure, and stretch state. Use the Sensitivity slider to tune how much faint signal is included, then switch to Edit Points to refine." );
   lines.push( "" );
   lines.push( "Reset" );
   lines.push( "  • Reset Mask (in the Tools section) clears just the current nucleus + tail geometry; sliders and options stay." );
   lines.push( "  • Reset to Defaults (at the top of the panel) clears geometry AND snaps every slider, dropdown, and checkbox back to factory defaults." );
   lines.push( "" );
   lines.push( "Acknowledgements" );
   lines.push( "  • With thanks to Hartmut Bornemann and his GAME (Galaxy and Emission nebula Mask Editor) script — the original PixInsight mask-drawing tool that pioneered click-to-draw mask editing inside PixInsight and inspired this script's UX." );
   lines.push( "      GAME and Hartmut's other PixInsight scripts:  http://skypixels.at/pixinsight_scripts.html" );


   this.text_TextBox = new TextBox( this );
   this.text_TextBox.readOnly = true;
   this.text_TextBox.text = lines.join( "\n" );
   this.text_TextBox.setMinSize( 80 * this.font.width( "M" ), 30 * this.font.lineSpacing );
   // Land at the top of the document — without this the TextBox can open
   // scrolled mid-way (the caret defaults to end-of-text after .text =).
   this.text_TextBox.caretPosition = 0;


   this.close_PushButton = new PushButton( this );
   this.close_PushButton.text = "Close";
   this.close_PushButton.defaultButton = true;
   this.close_PushButton.onClick = function() { this.dialog.ok(); };


   var buttonsSizer = new HorizontalSizer;
   buttonsSizer.addStretch();
   buttonsSizer.add( this.close_PushButton );


   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.text_TextBox );
   this.sizer.add( buttonsSizer );


   this.adjustToContents();
   this.userResizable = true;
}


InstructionsDialog.prototype = new Dialog;


// ----------------------------------------------------------------------------
// CometMaskDialog — full panel layout. M1 leaves all controls
// inert; later milestones wire up handlers.
// ----------------------------------------------------------------------------


function CometMaskDialog( srcView )
{
   this.__base__ = Dialog;
   this.__base__();


   this.windowTitle = TITLE + " " + VERSION;


   // ---- preview canvas (left side) ----
   this.preview = new CometMaskPreview( this, srcView );


   // ---- dialog state + methods (defined before any handler references them) ----
   var dialog = this;
   this.toolMode = TOOL_IDLE;
   this.suppressRadios = false;
   this.suppressNumericEdits = false;
   this.suppressLink = false;


   this.setToolMode = function( mode )
   {
      this.toolMode = mode;
      this.preview.toolMode = mode;
      this.preview.scrollbox.viewport.cursor = new Cursor( cursorForToolMode( mode ) );


      this.suppressRadios = true;
      try
      {
         this.autoDetect_RadioButton.checked    = (mode == TOOL_AUTO_DETECT);
         this.placeNucleus_RadioButton.checked  = (mode == TOOL_PLACE_NUCLEUS);
         this.addTailVertex_RadioButton.checked = (mode == TOOL_ADD_TAIL_VERTEX);
         this.idle_RadioButton.checked          = (mode == TOOL_IDLE);
      }
      finally
      {
         this.suppressRadios = false;
      }


      // Sensitivity is only meaningful in Auto Detect mode.
      this.autoSensitivity_NumericControl.enabled = (mode == TOOL_AUTO_DETECT);


      // Entering Add Tail Mask with link on + nucleus present seeds the
      // anchor vertex so the user has visible state before their first click.
      if ( mode == TOOL_ADD_TAIL_VERTEX )
      {
         this.preview.ensureTailAnchorIfLinked();
         this.preview.scrollbox.viewport.update();
      }
   };


   this.syncNumericFromNucleus = function()
   {
      var n = this.preview.nucleus;
      this.suppressNumericEdits = true;
      try
      {
         if ( n != null )
         {
            this.nucleusX_NumericEdit.setValue( n.x );
            this.nucleusY_NumericEdit.setValue( n.y );
            this.nucleusRx_NumericEdit.setValue( n.Rx );
            this.nucleusRy_NumericEdit.setValue( n.Ry );
         }
      }
      finally
      {
         this.suppressNumericEdits = false;
      }
   };


   // Clears nucleus + tail geometry, snaps every UI control back to its
   // factory default, and resets zoom + tool mode. Does NOT close any
   // output ImageWindows that previous Execute calls may have produced —
   // those live independently of the dialog.
   this.resetAllToDefaults = function()
   {
      var p = this.preview;


      p.nucleus = null;
      p.tail = null;
      p.tailSmooth = 0.5;
      p.activeDrag = null;
      p.linkBaselineX = null;
      p.linkBaselineY = null;


      this.suppressNumericEdits = true;
      try
      {
         this.nucleusX_NumericEdit.setValue( 0 );
         this.nucleusY_NumericEdit.setValue( 0 );
         this.nucleusRx_NumericEdit.setValue( 60 );
         this.nucleusRy_NumericEdit.setValue( 60 );
         this.nucleusCore_NumericControl.setValue( 0.05 );
         this.nucleusSigma_NumericControl.setValue( 42.0 );
         this.tailCore_NumericControl.setValue( 0.50 );
         this.tailFadeStart_NumericControl.setValue( 60 );
         this.tailFadeAmount_NumericControl.setValue( 80 );
         this.tailSmooth_NumericControl.setValue( 0.5 );
         this.tailSigma_NumericControl.setValue( 46.0 );
         this.outputGamma_NumericControl.setValue( 1.25 );
         this.autoSensitivity_NumericControl.setValue( 50 );
      }
      finally { this.suppressNumericEdits = false; }


      this.tailUseSoftEdges_CheckBox.checked    = true;
      this.tailUseFadeFromHead_CheckBox.checked = true;
      this.applyTailMetricEnabledState();


      this.nucleusSoftenDirection_ComboBox.currentItem = 2;  // Split
      this.tailSoftenDirection_ComboBox.currentItem    = 2;  // Split


      this.combineMode_ComboBox.currentItem = 0;
      this.outputMaskType_ComboBox.currentItem = 0;
      this.outputGamma_NumericControl.enabled = false;  // Binary default
      this.outputPrimary_ComboBox.currentItem = 0;
      this.outputComponents_CheckBox.checked = false;
      this.outputInvert_CheckBox.checked = false;


      // Reset re-evaluates linear/stretched: the source might have been
      // changed (or the user prefers the auto behavior again).
      var stfDefault = isLikelyLinear( p.srcView );
      this.stfPreview_CheckBox.checked = stfDefault;
      p.setApplyStfPreview( stfDefault );


      this.suppressLink = true;
      try { this.linkTailToNucleus_CheckBox.checked = true; }
      finally { this.suppressLink = false; }
      p.setLinkTailToNucleus( true );


      // Reset clears geometry, so jump back into Place Nucleus mode.
      this.setToolMode( TOOL_PLACE_NUCLEUS );


      if ( p.onTailChanged ) p.onTailChanged();


      p.resetZoom();
      p.scrollbox.viewport.update();
   };


   // Clear just the current mask geometry (nucleus + tail), leaving every
   // slider, dropdown, and checkbox value as the user has them. Used by
   // the "Reset Mask" button in the Tools section so the user can start
   // a fresh mask without losing their tuning.
   this.resetMaskGeometry = function()
   {
      var p = this.preview;
      p.nucleus = null;
      p.tail = null;
      p.activeDrag = null;
      p.linkBaselineX = null;
      p.linkBaselineY = null;


      this.suppressNumericEdits = true;
      try
      {
         this.nucleusX_NumericEdit.setValue( 0 );
         this.nucleusY_NumericEdit.setValue( 0 );
         this.nucleusRx_NumericEdit.setValue( 60 );
         this.nucleusRy_NumericEdit.setValue( 60 );
      }
      finally { this.suppressNumericEdits = false; }


      // Geometry is gone, so jump back into Place Nucleus mode.
      this.setToolMode( TOOL_PLACE_NUCLEUS );


      if ( p.onTailChanged ) p.onTailChanged();
      p.scrollbox.viewport.update();
   };


   // Run the Auto Detect Comet pass at one click point. Confirms before
   // replacing any existing geometry, then swaps the preview's nucleus +
   // tail to the detected geometry and jumps back into Edit Points so the
   // user can immediately refine.
   this.runAutoDetect = function( imageX, imageY )
   {
      var p = this.preview;
      var hasGeometry = (p.nucleus != null)
                     || (p.tail != null && p.tail.vertices.length > 0);
      if ( hasGeometry )
      {
         var box = new MessageBox(
            "Replace the current nucleus and tail with auto-detected geometry?",
            TITLE, StdIcon_Question, StdButton_Yes, StdButton_No );
         if ( box.execute() != StdButton_Yes ) return;
      }


      Console.show();
      var sensitivity = this.autoSensitivity_NumericControl.value / 100;


      try
      {
         var result = autoDetectComet( srcView, imageX, imageY, sensitivity );


         p.nucleus = result.nucleus;
         p.tail = result.tail;
         p.activeDrag = null;
         p.linkBaselineX = null;
         p.linkBaselineY = null;
         // Re-establish the link baseline if Link is on so the tail
         // moves rigidly with the new nucleus from this point forward.
         p.setLinkTailToNucleus( p.linkTailToNucleus );


         // Notify the dialog so numeric edits / vertex count label update.
         p._notifyNucleusChanged();
         p._notifyTailChanged();


         // Jump into Edit Points so the user can immediately refine.
         this.setToolMode( TOOL_IDLE );


         p.scrollbox.viewport.update();
      }
      catch ( ex )
      {
         var msg = ex.toString();
         if ( msg.indexOf( "Aborted by user" ) >= 0 )
            Console.warningln( "<end><cbr>", TITLE, " auto-detect aborted." );
         else
         {
            Console.criticalln( "<end><cbr>*** ", TITLE,
               " auto-detect error: ", msg );
            (new MessageBox( msg, TITLE,
                             StdIcon_Error, StdButton_Ok )).execute();
         }
      }
      finally
      {
         try { Console.abortEnabled = false; } catch ( e ) {}
      }
   };


   // Soft Edges and Fade from Head are independent toggles. Core fraction
   // is only meaningful when Soft Edges is on; Fade start + Fade amount
   // are only meaningful when Fade from Head is on. Toggle each slider's
   // enabled state so it's clear at a glance which apply.
   this.applyTailMetricEnabledState = function()
   {
      this.tailCore_NumericControl.enabled       =
         this.tailUseSoftEdges_CheckBox.checked;
      this.tailFadeStart_NumericControl.enabled  =
         this.tailUseFadeFromHead_CheckBox.checked;
      this.tailFadeAmount_NumericControl.enabled =
         this.tailUseFadeFromHead_CheckBox.checked;
   };


   // Snapshot of preview + UI control state for the engine. Called at OK.
   this.collectParams = function()
   {
      var preview = this.preview;
      var p = {};


      p.nucleus = preview.nucleus
         ? { x: preview.nucleus.x, y: preview.nucleus.y,
             Rx: preview.nucleus.Rx, Ry: preview.nucleus.Ry,
             theta: preview.nucleus.theta || 0 }
         : null;


      p.tailPath = (preview.tail != null && preview.tail.vertices.length >= 3)
         ? buildTailPath( preview.tail, preview.tailSmooth )
         : null;
      p.tailAnchor = (preview.tail != null
                      && preview.tail.vertices.length > 0
                      && preview.tail.anchorIndex >= 0
                      && preview.tail.anchorIndex < preview.tail.vertices.length)
         ? new Point( preview.tail.vertices[preview.tail.anchorIndex].x,
                      preview.tail.vertices[preview.tail.anchorIndex].y )
         : null;


      p.tailUseSoftEdges    = this.tailUseSoftEdges_CheckBox.checked;
      p.tailUseFadeFromHead = this.tailUseFadeFromHead_CheckBox.checked;
      p.nucleusCore  = this.nucleusCore_NumericControl.value;
      p.nucleusSigma = this.nucleusSigma_NumericControl.value;
      p.tailCore     = this.tailCore_NumericControl.value;
      p.tailSigma    = this.tailSigma_NumericControl.value;
      // Fade start: UI is 0..100 % (head → tip), engine wants 0..1 fraction.
      p.tailFadeStart  = this.tailFadeStart_NumericControl.value / 100;
      // Fade amount: UI is "% of fade applied" where 0% = no fade and
      // 100% = full fade to dark tip. The engine internally uses
      // "tip brightness" (1 = no fade, 0 = full fade). Invert so the user-
      // facing slider reads naturally as "fade intensity".
      p.tailFadeAmount = 1 - this.tailFadeAmount_NumericControl.value / 100;


      var softenDirs = ['inward', 'outward', 'split'];
      p.nucleusSoftenDirection = softenDirs[this.nucleusSoftenDirection_ComboBox.currentItem];
      p.tailSoftenDirection    = softenDirs[this.tailSoftenDirection_ComboBox.currentItem];


      var combineModes = ['screen', 'union', 'additive', 'intersection'];
      p.combineMode = combineModes[this.combineMode_ComboBox.currentItem];


      var primaries = ['combined', 'nucleus', 'tail'];
      p.outputPrimary = primaries[this.outputPrimary_ComboBox.currentItem];


      var maskTypes = ['binary', 'luminance'];
      p.maskType = maskTypes[this.outputMaskType_ComboBox.currentItem];
      p.maskGamma = this.outputGamma_NumericControl.value;


      p.outputComponents = this.outputComponents_CheckBox.checked;
      p.outputInvert     = this.outputInvert_CheckBox.checked;


      return p;
   };


   this.preview.onNucleusChanged = function()
   {
      dialog.syncNumericFromNucleus();
   };
   this.preview.onTailChanged = function()
   {
      var n = (dialog.preview.tail != null) ? dialog.preview.tail.vertices.length : 0;
      dialog.tailVertexCount_Label.text = "Vertices: " + n;
   };
   this.preview.onToolModeChanged = function( newMode )
   {
      dialog.setToolMode( newMode );
   };
   this.preview.onAutoDetectRequested = function( imageX, imageY )
   {
      dialog.runAutoDetect( imageX, imageY );
   };


   // ---- right-side controls ----
   //
   // Tools panel. "Auto Detect Comet" sits at the top as the easiest
   // one-click path. Then the manual placement modes in workflow order:
   // Place Nucleus, Add Tail Mask, Edit Points (the bare-cursor mode
   // where drag / insert-edge / right-click-delete all live; the
   // underlying tool constant is still TOOL_IDLE).
   //
   this.autoDetect_RadioButton = new RadioButton( this );
   this.autoDetect_RadioButton.text = "Auto Detect Comet - EXPERIMENTAL";
   this.autoDetect_RadioButton.toolTip =
      "Click once on the comet's bright head and the script will try to\n" +
      "identify the nucleus and tail automatically and create both masks\n" +
      "in one shot. The Sensitivity slider below tunes how much faint\n" +
      "signal to include. If existing geometry is present, you'll be\n" +
      "asked to confirm before it's replaced.";
   this.autoDetect_RadioButton.onClick = function( checked )
   {
      if ( !dialog.suppressRadios && checked ) dialog.setToolMode( TOOL_AUTO_DETECT );
   };


   this.placeNucleus_RadioButton = new RadioButton( this );
   this.placeNucleus_RadioButton.text = "Place Nucleus";
   this.placeNucleus_RadioButton.checked = true;
   this.placeNucleus_RadioButton.toolTip =
      "Click on the image to place the comet's bright head — an ellipse\n" +
      "appears that you can later resize and rotate. After placing, the\n" +
      "tool automatically switches to Edit Points so you can refine it.";
   this.placeNucleus_RadioButton.onClick = function( checked )
   {
      if ( !dialog.suppressRadios && checked ) dialog.setToolMode( TOOL_PLACE_NUCLEUS );
   };


   this.addTailVertex_RadioButton = new RadioButton( this );
   this.addTailVertex_RadioButton.text = "Add Tail Mask";
   this.addTailVertex_RadioButton.toolTip =
      "Click on the image to add corner points that outline the comet's\n" +
      "tail. Each click adds a new corner — the script connects them in\n" +
      "order as you go. The first point is auto-anchored at the nucleus\n" +
      "(when Link tail to nucleus is on), so your first click should be\n" +
      "the next point out along the tail. Stays active until you switch\n" +
      "modes, so you can build the whole polygon in one pass.";
   this.addTailVertex_RadioButton.onClick = function( checked )
   {
      if ( !dialog.suppressRadios && checked ) dialog.setToolMode( TOOL_ADD_TAIL_VERTEX );
   };


   this.idle_RadioButton = new RadioButton( this );
   this.idle_RadioButton.text = "Edit Points  (drag / insert / delete)";
   this.idle_RadioButton.toolTip =
      "The bare cursor mode. Drag any handle to move it: the nucleus\n" +
      "center, its rim handles (which resize and rotate the ellipse), or\n" +
      "any tail corner. Click on a tail edge between corners to insert a\n" +
      "new corner there. Right-click a tail corner to delete it.";
   this.idle_RadioButton.onClick = function( checked )
   {
      if ( !dialog.suppressRadios && checked ) dialog.setToolMode( TOOL_IDLE );
   };


   this.linkTailToNucleus_CheckBox = new CheckBox( this );
   this.linkTailToNucleus_CheckBox.text = "Link tail to nucleus";
   this.linkTailToNucleus_CheckBox.checked = true;
   this.linkTailToNucleus_CheckBox.toolTip =
      "When checked, the polygon's first vertex stays anchored to the nucleus center.";
   this.linkTailToNucleus_CheckBox.onCheck = function( checked )
   {
      if ( dialog.suppressLink ) return;
      var p = dialog.preview;


      if ( !checked )
      {
         p.setLinkTailToNucleus( false );
         p.scrollbox.viewport.update();   // anchor-vertex visual changes color
         return;
      }


      // Re-linking: if the anchor has drifted, offer to translate the
      // entire tail (rigid body) so the anchor sits back at the nucleus.
      // The polygon's shape is preserved.
      var willMove = false;
      var dx = 0, dy = 0;
      if ( p.tail != null && p.nucleus != null )
      {
         var ai = p.tail.anchorIndex;
         if ( ai >= 0 && ai < p.tail.vertices.length )
         {
            var v = p.tail.vertices[ai];
            dx = p.nucleus.x - v.x;
            dy = p.nucleus.y - v.y;
            if ( Math.abs( dx ) > 0.5 || Math.abs( dy ) > 0.5 )
               willMove = true;
         }
      }


      if ( willMove )
      {
         var box = new MessageBox(
            "Re-linking will translate the entire tail polygon so its " +
            "anchor vertex sits at the nucleus center.\n\nContinue?",
            TITLE, StdIcon_Question, StdButton_Yes, StdButton_No );
         if ( box.execute() != StdButton_Yes )
         {
            dialog.suppressLink = true;
            try { this.checked = false; }
            finally { dialog.suppressLink = false; }
            return;
         }


         for ( var i = 0; i < p.tail.vertices.length; ++i )
         {
            p.tail.vertices[i].x += dx;
            p.tail.vertices[i].y += dy;
         }
         p._notifyTailChanged();
      }


      p.setLinkTailToNucleus( true );
      p.scrollbox.viewport.update();
   };


   var toolsSizer = new VerticalSizer;
   toolsSizer.spacing = 4;
   this.autoSensitivity_NumericControl = makeNumericControl(
      this, "Sensitivity (%)", 50, 0, 100, 0 );
   this.autoSensitivity_NumericControl.toolTip =
      "How sensitive Auto Detect Comet is to faint signal.\n" +
      "  0%   = only pixels nearly as bright as the click are included\n" +
      "         (small tight masks).\n" +
      "  50%  = balanced (default).\n" +
      "  100% = include very faint pixels around the click (big loose\n" +
      "         masks; may also pick up nearby stars or background).\n" +
      "Only meaningful while Auto Detect Comet is selected.";


   this.resetMask_PushButton = new PushButton( this );
   this.resetMask_PushButton.text = "Reset Mask";
   this.resetMask_PushButton.toolTip =
      "Clear the current nucleus and tail geometry so you can start a\n" +
      "fresh mask. Slider values, dropdowns, and checkboxes are left\n" +
      "alone — use Reset to Defaults at the top of the panel to also\n" +
      "reset those.";
   this.resetMask_PushButton.onClick = function()
   {
      dialog.resetMaskGeometry();
   };


   toolsSizer.add( this.autoDetect_RadioButton );
   toolsSizer.add( this.placeNucleus_RadioButton );
   toolsSizer.add( this.addTailVertex_RadioButton );
   toolsSizer.add( this.idle_RadioButton );
   toolsSizer.addSpacing( 4 );
   toolsSizer.add( this.autoSensitivity_NumericControl );
   toolsSizer.addSpacing( 4 );
   toolsSizer.add( this.linkTailToNucleus_CheckBox );
   toolsSizer.addSpacing( 4 );
   toolsSizer.add( this.resetMask_PushButton );


   this.tools_GroupBox = new GroupBox( this );
   this.tools_GroupBox.title = "Tools";
   this.tools_GroupBox.sizer = toolsSizer;
   this.tools_GroupBox.sizer.margin = 6;


   //
   // Nucleus panel
   //
   this.nucleusX_NumericEdit  = makeNumericEdit( this, "X",   0, 0, srcView.image.width,  2 );
   this.nucleusY_NumericEdit  = makeNumericEdit( this, "Y",   0, 0, srcView.image.height, 2 );
   this.nucleusRx_NumericEdit = makeNumericEdit( this, "Rx", 60, 1, srcView.image.width,  2 );
   this.nucleusRy_NumericEdit = makeNumericEdit( this, "Ry", 60, 1, srcView.image.height, 2 );
   this.nucleusX_NumericEdit.toolTip =
      "Horizontal position of the nucleus center, in image pixels.\n" +
      "Type a value to move the nucleus precisely; or drag the yellow\n" +
      "center handle on the canvas.";
   this.nucleusY_NumericEdit.toolTip =
      "Vertical position of the nucleus center, in image pixels.";
   this.nucleusRx_NumericEdit.toolTip =
      "Half-length of the nucleus ellipse along its long (X) axis,\n" +
      "in image pixels. Drag the cyan rim handle on the canvas to set\n" +
      "this visually (which also rotates the ellipse).";
   this.nucleusRy_NumericEdit.toolTip =
      "Half-length of the nucleus ellipse along its short (Y) axis,\n" +
      "in image pixels.";


   function bindNucleusEdit( edit, field )
   {
      edit.onValueUpdated = function( value )
      {
         if ( dialog.suppressNumericEdits ) return;
         if ( dialog.preview.nucleus == null )
         {
            // No nucleus yet — instantiating one from the X/Y inputs is
            // confusing. Snap the edit back to 0 to make that clear.
            dialog.suppressNumericEdits = true;
            try { this.setValue( 0 ); }
            finally { dialog.suppressNumericEdits = false; }
            return;
         }
         dialog.preview.nucleus[field] = value;
         // X/Y edits move the nucleus center; the linked anchor must follow.
         // Rx/Ry don't change position but enforceAnchorLink is cheap.
         dialog.preview._notifyNucleusChanged();
         dialog.preview.scrollbox.viewport.update();
      };
   }
   bindNucleusEdit( this.nucleusX_NumericEdit,  'x' );
   bindNucleusEdit( this.nucleusY_NumericEdit,  'y' );
   bindNucleusEdit( this.nucleusRx_NumericEdit, 'Rx' );
   bindNucleusEdit( this.nucleusRy_NumericEdit, 'Ry' );


   var nucXY = new HorizontalSizer;
   nucXY.spacing = 8;
   nucXY.add( this.nucleusX_NumericEdit );
   nucXY.add( this.nucleusY_NumericEdit );


   var nucRxRy = new HorizontalSizer;
   nucRxRy.spacing = 8;
   nucRxRy.add( this.nucleusRx_NumericEdit );
   nucRxRy.add( this.nucleusRy_NumericEdit );


   this.nucleusCore_NumericControl = makeNumericControl(
      this, "Core fraction", 0.05, 0.0, 1.0, 3 );
   this.nucleusCore_NumericControl.toolTip =
      "How much of the nucleus stays at full brightness before fading\n" +
      "toward the edge.\n" +
      "  0   = mask fades from the very center to the rim.\n" +
      "  0.5 = inner half is solid bright; outer half fades to dark.\n" +
      "  1   = the whole ellipse is full brightness with no fade.";
   this.nucleusSigma_NumericControl = makeNumericControl(
      this, "Soften σ (px)", 42.0, 0.0, 200.0, 1 );
   this.nucleusSigma_NumericControl.toolTip =
      "How much to blur the nucleus mask edges, measured in pixels.\n" +
      "Higher = softer, more diffuse mask. 0 = no blur (sharp ellipse).\n" +
      "The blur direction is set by the Soften dropdown below.";
   this.nucleusSoftenDirection_ComboBox = makeSoftenDirectionCombo( this );


   var nucleusSizer = new VerticalSizer;
   nucleusSizer.spacing = 4;
   nucleusSizer.add( nucXY );
   nucleusSizer.add( nucRxRy );
   nucleusSizer.addSpacing( 4 );
   nucleusSizer.add( this.nucleusCore_NumericControl );
   nucleusSizer.add( this.nucleusSigma_NumericControl );
   nucleusSizer.add( makeLabeledComboRow( "Soften:", this.nucleusSoftenDirection_ComboBox ) );


   this.nucleus_GroupBox = new GroupBox( this );
   this.nucleus_GroupBox.title = "Nucleus";
   this.nucleus_GroupBox.sizer = nucleusSizer;
   this.nucleus_GroupBox.sizer.margin = 6;


   //
   // Tail panel
   //
   this.tailVertexCount_Label = new Label( this );
   this.tailVertexCount_Label.text = "Vertices: 0";
   this.tailVertexCount_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;


   this.tailUseSoftEdges_CheckBox = new CheckBox( this );
   this.tailUseSoftEdges_CheckBox.text = "Soft Edges";
   this.tailUseSoftEdges_CheckBox.checked = true;
   this.tailUseSoftEdges_CheckBox.toolTip =
      "When on, the tail mask is bright in the middle of the polygon and\n" +
      "fades evenly toward all edges — soft feathered border. Use the\n" +
      "Core fraction slider below to set how much of the interior stays\n" +
      "fully bright before the fade begins.\n" +
      "Combinable with Fade from Head: when both are on, the two gradients\n" +
      "multiply, giving a tail that is feathered all around AND fades from\n" +
      "head to tip. When both are off, the polygon is solid (no internal\n" +
      "gradient — only the global Soften σ applies).";
   this.tailUseSoftEdges_CheckBox.onCheck = function( checked )
   {
      dialog.applyTailMetricEnabledState();
   };


   this.tailUseFadeFromHead_CheckBox = new CheckBox( this );
   this.tailUseFadeFromHead_CheckBox.text = "Fade from Head";
   this.tailUseFadeFromHead_CheckBox.checked = true;
   this.tailUseFadeFromHead_CheckBox.toolTip =
      "When on, the tail mask is brightest at the head (the vertex linked\n" +
      "to the nucleus) and fades along the tail's axis toward the tip.\n" +
      "Use the Fade start and Fade amount sliders below to control where\n" +
      "the fade begins and how dark the tip ends up.\n" +
      "Combinable with Soft Edges (see that checkbox's tooltip).";
   this.tailUseFadeFromHead_CheckBox.onCheck = function( checked )
   {
      dialog.applyTailMetricEnabledState();
   };


   var tailMetricSizer = new VerticalSizer;
   tailMetricSizer.spacing = 2;
   tailMetricSizer.add( this.tailUseSoftEdges_CheckBox );
   tailMetricSizer.add( this.tailUseFadeFromHead_CheckBox );


   this.tailCore_NumericControl = makeNumericControl(
      this, "Core fraction", 0.50, 0.0, 1.0, 3 );
   this.tailCore_NumericControl.toolTip =
      "How much of the tail polygon's interior stays at full brightness\n" +
      "before fading toward the edge.\n" +
      "  0   = mask fades from the very center to the polygon edge.\n" +
      "  0.5 = inner half is solid bright; outer half fades to dark.\n" +
      "  1   = the whole polygon is full brightness with no fade.\n" +
      "Greyed out when metric is 'Fade from Head' — the fade sliders\n" +
      "below replace this control in that mode.";
   this.tailSmooth_NumericControl = makeNumericControl(
      this, "Smooth Lines", 0.5, 0.0, 1.0, 3 );
   this.tailSmooth_NumericControl.toolTip =
      "Round off the tail polygon's corners with smooth curves.\n" +
      "  0   = sharp angles where each click landed.\n" +
      "  0.5 = gentle rounded curve through the corners (default).\n" +
      "  1   = maximum smoothing.\n" +
      "Both the on-screen outline and the generated mask follow the\n" +
      "smoothed shape.";
   this.tailSmooth_NumericControl.onValueUpdated = function( value )
   {
      dialog.preview.tailSmooth = value;
      dialog.preview.scrollbox.viewport.update();
   };
   this.tailSigma_NumericControl = makeNumericControl(
      this, "Soften σ (px)", 46.0, 0.0, 200.0, 1 );
   this.tailSigma_NumericControl.toolTip =
      "How much to blur the tail mask edges, measured in pixels.\n" +
      "Higher = softer, more diffuse outline. 0 = no blur (sharp polygon).\n" +
      "The blur direction is set by the Soften dropdown below.";
   this.tailSoftenDirection_ComboBox = makeSoftenDirectionCombo( this );


   // Fade-from-Head specific controls. Both shown as percentages 0..100;
   // collectParams converts to 0..1 for the engine.
   this.tailFadeAmount_NumericControl = makeNumericControl(
      this, "Fade amount (%)", 80, 0, 100, 0 );
   this.tailFadeAmount_NumericControl.toolTip =
      "How much fading to apply along the tail, as a percentage.\n" +
      "  0%   = no fade — whole tail stays at full brightness.\n" +
      "  80%  = strong fade (default — tail tip ends at 20% brightness).\n" +
      "  100% = full fade — tail tip fades completely to dark.\n" +
      "Has no effect when Fade from Head is unchecked.";


   this.tailFadeStart_NumericControl = makeNumericControl(
      this, "Fade start (%)", 60, 0, 100, 0 );
   this.tailFadeStart_NumericControl.toolTip =
      "Where the fade begins along the tail, as a percentage of the\n" +
      "distance from the head to the tip.\n" +
      "  0%   = fade starts right at the head.\n" +
      "  60%  = the first 60% of the tail stays at full brightness,\n" +
      "         then fades over the remaining 40% (default).\n" +
      "  100% = no fade visible (fade would start at the tip).\n" +
      "Has no effect when metric is Soft Edges.";


   var tailSizer = new VerticalSizer;
   tailSizer.spacing = 4;
   tailSizer.add( this.tailVertexCount_Label );
   tailSizer.addSpacing( 4 );
   tailSizer.add( tailMetricSizer );
   tailSizer.addSpacing( 4 );
   tailSizer.add( this.tailCore_NumericControl );
   tailSizer.add( this.tailFadeStart_NumericControl );
   tailSizer.add( this.tailFadeAmount_NumericControl );
   tailSizer.add( this.tailSmooth_NumericControl );
   tailSizer.add( this.tailSigma_NumericControl );
   tailSizer.add( makeLabeledComboRow( "Soften:", this.tailSoftenDirection_ComboBox ) );


   this.tail_GroupBox = new GroupBox( this );
   this.tail_GroupBox.title = "Tail";
   this.tail_GroupBox.sizer = tailSizer;
   this.tail_GroupBox.sizer.margin = 6;


   //
   // Combine panel
   //
   this.combineMode_ComboBox = new ComboBox( this );
   this.combineMode_ComboBox.addItem( "Screen" );
   this.combineMode_ComboBox.addItem( "Union (max)" );
   this.combineMode_ComboBox.addItem( "Additive (clipped)" );
   this.combineMode_ComboBox.addItem( "Intersection (min)" );
   this.combineMode_ComboBox.currentItem = 0;
   this.combineMode_ComboBox.toolTip =
      "How the nucleus and tail masks are merged into the Combined output:\n" +
      "  Screen (default): soft additive blend; overlapping areas brighten\n" +
      "    smoothly without hard clipping.\n" +
      "  Union: keeps whichever value is higher per pixel — like a logical OR.\n" +
      "  Additive: sums the two masks and clips to 1; can produce harder\n" +
      "    overlaps than Screen.\n" +
      "  Intersection: keeps whichever value is lower per pixel — only the\n" +
      "    overlap of the two regions stays bright.";


   var combineSizer = new HorizontalSizer;
   combineSizer.spacing = 6;
   var combineLabel = new Label( this );
   combineLabel.text = "Mode:";
   combineLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   combineSizer.add( combineLabel );
   combineSizer.add( this.combineMode_ComboBox, 100 );


   this.combine_GroupBox = new GroupBox( this );
   this.combine_GroupBox.title = "Combine";
   this.combine_GroupBox.sizer = combineSizer;
   this.combine_GroupBox.sizer.margin = 6;


   //
   // Output panel
   //
   this.outputMaskType_ComboBox = new ComboBox( this );
   this.outputMaskType_ComboBox.addItem( "Binary" );
   this.outputMaskType_ComboBox.addItem( "Luminance" );
   this.outputMaskType_ComboBox.currentItem = 0;
   this.outputMaskType_ComboBox.toolTip =
      "How to weight the mask values:\n" +
      "  Binary: pure geometric mask — bright in the comet region, dark\n" +
      "    outside, with the falloff and soften you've configured.\n" +
      "  Luminance: same shape, but each pixel's mask value is multiplied\n" +
      "    by the actual brightness of the underlying image. Bright parts\n" +
      "    of the comet get more mask weight; dark sky stays close to zero\n" +
      "    even inside the polygon. The Mask gamma slider below tweaks the\n" +
      "    final brightness curve when this is selected.";
   this.outputMaskType_ComboBox.onItemSelected = function( idx )
   {
      var isLum = (idx == 1);
      dialog.outputGamma_NumericControl.enabled = isLum;
   };


   this.outputGamma_NumericControl = makeNumericControl(
      this, "Mask gamma", 1.25, 0.10, 4.00, 2 );
   this.outputGamma_NumericControl.toolTip =
      "Brightness adjustment for the Luminance mask:\n" +
      "  1.0 = no change (default).\n" +
      "  Higher values brighten the mid-tones (mask carries more weight\n" +
      "    in moderately bright parts of the image).\n" +
      "  Lower values darken the mid-tones.\n" +
      "Greyed out when Mask type is Binary — the geometric mask isn't a\n" +
      "brightness signal, so this slider has nothing to work with there.";
   this.outputGamma_NumericControl.enabled = false;  // Binary by default


   this.outputPrimary_ComboBox = new ComboBox( this );
   this.outputPrimary_ComboBox.addItem( "Combined" );
   this.outputPrimary_ComboBox.addItem( "Nucleus only" );
   this.outputPrimary_ComboBox.addItem( "Tail only" );
   this.outputPrimary_ComboBox.currentItem = 0;
   this.outputPrimary_ComboBox.toolTip =
      "Which mask image is the main output of Create Mask:\n" +
      "  Combined: nucleus and tail merged via the Combine mode above.\n" +
      "  Nucleus only: just the head ellipse mask, without the tail.\n" +
      "  Tail only: just the tail polygon mask, without the head.\n" +
      "Tick 'Also output components' to additionally produce the\n" +
      "single-region masks alongside this primary one.";


   this.outputComponents_CheckBox = new CheckBox( this );
   this.outputComponents_CheckBox.text = "Also output components";
   this.outputComponents_CheckBox.toolTip =
      "When checked, also produce the nucleus and tail as separate mask\n" +
      "windows in addition to the primary output above. Useful if you want\n" +
      "to use them independently in further processing.";


   this.outputInvert_CheckBox = new CheckBox( this );
   this.outputInvert_CheckBox.text = "Invert mask";
   this.outputInvert_CheckBox.toolTip =
      "When checked, the output is flipped so the comet region is dark and\n" +
      "the surrounding sky is bright (instead of the default bright comet\n" +
      "on dark background). Useful when feeding the mask to processes that\n" +
      "select 'protected' areas.";


   function makeLabeledComboRow( labelText, combo )
   {
      var row = new HorizontalSizer;
      row.spacing = 6;
      var lbl = new Label( dialog );
      lbl.text = labelText;
      lbl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
      row.add( lbl );
      row.add( combo, 100 );
      return row;
   }


   var outputSizer = new VerticalSizer;
   outputSizer.spacing = 4;
   outputSizer.add( makeLabeledComboRow( "Mask type:", this.outputMaskType_ComboBox ) );
   outputSizer.add( this.outputGamma_NumericControl );
   outputSizer.add( makeLabeledComboRow( "Mask:",      this.outputPrimary_ComboBox ) );
   outputSizer.add( this.outputComponents_CheckBox );
   outputSizer.add( this.outputInvert_CheckBox );


   this.output_GroupBox = new GroupBox( this );
   this.output_GroupBox.title = "Output";
   this.output_GroupBox.sizer = outputSizer;
   this.output_GroupBox.sizer.margin = 6;


   //
   // Right-column stack. "Reset to Defaults" is a global control that
   // resets EVERY option in the dialog, so it sits outside the per-
   // section group boxes — at the top of the column where it's always
   // visible and clearly not tied to any specific section.
   //
   this.resetToDefaults_PushButton = new PushButton( this );
   this.resetToDefaults_PushButton.text = "Reset to Defaults";
   this.resetToDefaults_PushButton.toolTip =
      "Reset every option in the dialog — geometry (nucleus and tail),\n" +
      "every slider, every dropdown, every checkbox — to its default\n" +
      "value. Mask windows you've already created with Create Mask stay\n" +
      "open; only the dialog state resets.";
   this.resetToDefaults_PushButton.onClick = function()
   {
      dialog.resetAllToDefaults();
   };


   this.instructions_PushButton = new PushButton( this );
   this.instructions_PushButton.text = "Instructions";
   this.instructions_PushButton.toolTip =
      "Open a scrolling help window with basic-usage steps for building\n" +
      "a comet mask: place the nucleus, add the tail, refine in Edit\n" +
      "Points, adjust softness and output options, and create the mask.";
   this.instructions_PushButton.onClick = function()
   {
      var help = new InstructionsDialog( dialog );
      help.execute();
   };


   var topButtons_Sizer = new HorizontalSizer;
   topButtons_Sizer.spacing = 6;
   topButtons_Sizer.add( this.resetToDefaults_PushButton );
   topButtons_Sizer.add( this.instructions_PushButton );


   var rightSizer = new VerticalSizer;
   rightSizer.margin = 4;
   rightSizer.spacing = 6;
   rightSizer.add( topButtons_Sizer );
   rightSizer.addSpacing( 4 );
   rightSizer.add( this.tools_GroupBox );
   rightSizer.add( this.nucleus_GroupBox );
   rightSizer.add( this.tail_GroupBox );
   rightSizer.add( this.combine_GroupBox );
   rightSizer.add( this.output_GroupBox );
   rightSizer.addStretch();


   //
   // Zoom toolbar (sits below the preview canvas)
   //
   this.zoomOut_ToolButton = new ToolButton( this );
   this.zoomOut_ToolButton.text = "−";   // U+2212 minus sign
   this.zoomOut_ToolButton.toolTip = "Zoom out";
   this.zoomOut_ToolButton.setScaledFixedSize( 28, 24 );
   this.zoomOut_ToolButton.onClick = function()
   {
      var p = dialog.preview;
      p.setZoom( p.zoom / 1.25 );
   };


   this.zoomIn_ToolButton = new ToolButton( this );
   this.zoomIn_ToolButton.text = "+";
   this.zoomIn_ToolButton.toolTip = "Zoom in";
   this.zoomIn_ToolButton.setScaledFixedSize( 28, 24 );
   this.zoomIn_ToolButton.onClick = function()
   {
      var p = dialog.preview;
      p.setZoom( p.zoom * 1.25 );
   };


   this.zoomFit_ToolButton = new ToolButton( this );
   this.zoomFit_ToolButton.text = "Fit";
   this.zoomFit_ToolButton.toolTip = "Reset zoom (fit image to canvas).";
   this.zoomFit_ToolButton.setScaledFixedSize( 40, 24 );
   this.zoomFit_ToolButton.onClick = function()
   {
      dialog.preview.resetZoom();
   };


   this.zoom100_ToolButton = new ToolButton( this );
   this.zoom100_ToolButton.text = "100%";
   this.zoom100_ToolButton.toolTip =
      "Zoom to actual pixel size (1 image pixel = 1 viewport pixel),\n" +
      "centered on the current viewport.";
   this.zoom100_ToolButton.setScaledFixedSize( 48, 24 );
   this.zoom100_ToolButton.onClick = function()
   {
      dialog.preview.setZoomToActualSize();
   };


   this.zoomLevel_Label = new Label( this );
   this.zoomLevel_Label.text = "100%";
   this.zoomLevel_Label.minWidth = 48;
   this.zoomLevel_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;


   this.preview.onZoomChanged = function( scale )
   {
      // scale is the image-to-canvas pixel ratio: 1.0 = 1 image px per
      // 1 viewport px (the "100%" button's target). Show as a percentage
      // of the source image's native resolution.
      dialog.zoomLevel_Label.text = Math.round( scale * 100 ) + "%";
   };


   this.stfPreview_CheckBox = new CheckBox( this );
   this.stfPreview_CheckBox.text = "STF stretch";
   this.stfPreview_CheckBox.checked = this.preview.applyStfPreview;
   this.stfPreview_CheckBox.toolTip =
      "When checked (default), the preview canvas applies an auto-STF\n" +
      "stretch so linear images are still visible while editing. Uncheck\n" +
      "to render the source view as PixInsight would display it on its\n" +
      "own (uses whatever STF the view itself has set, or none). Affects\n" +
      "the preview only — the generated mask is unchanged.";
   this.stfPreview_CheckBox.onCheck = function( checked )
   {
      dialog.preview.setApplyStfPreview( checked );
   };


   var zoomBar = new HorizontalSizer;
   zoomBar.spacing = 4;
   zoomBar.add( this.zoomOut_ToolButton );
   zoomBar.add( this.zoomIn_ToolButton );
   zoomBar.add( this.zoomFit_ToolButton );
   zoomBar.add( this.zoom100_ToolButton );
   zoomBar.addSpacing( 8 );
   zoomBar.add( this.zoomLevel_Label );
   zoomBar.addStretch();
   zoomBar.add( this.stfPreview_CheckBox );


   //
   // Left column: preview canvas stacked on top of the zoom toolbar.
   //
   var leftCol = new VerticalSizer;
   leftCol.spacing = 4;
   leftCol.add( this.preview, 100 );
   leftCol.add( zoomBar );


   //
   // Top row: left column + right control panels
   //
   var topSizer = new HorizontalSizer;
   topSizer.margin = 4;
   topSizer.spacing = 8;
   topSizer.add( leftCol, 100 );
   topSizer.add( rightSizer );


   //
   // Buttons. Create Mask generates the mask without closing the dialog
   // so the user can iterate; Done closes the dialog. Esc still cancels
   // via PJSR default. The global Reset to Defaults sits at the top of
   // the right-side panel column, not here.
   //
   this.execute_PushButton = new PushButton( this );
   this.execute_PushButton.text = "Create Mask";
   this.execute_PushButton.toolTip =
      "Generate the mask now using the current settings.\n" +
      "The dialog stays open — adjust and click Create Mask again to iterate.";
   this.execute_PushButton.onClick = function()
   {
      Console.show();
      try
      {
         var params = dialog.collectParams();
         var engine = new CometMaskEngine( srcView, params );
         engine.run();
      }
      catch ( ex )
      {
         var msg = ex.toString();
         if ( msg.indexOf( "Aborted by user" ) >= 0 )
         {
            // User-driven abort — log it but don't pop a dialog. Their
            // intent was clear; no need to interrupt them again.
            Console.warningln( "<end><cbr>", TITLE, " aborted." );
         }
         else
         {
            Console.criticalln( "<end><cbr>*** ", TITLE, " error: ", msg );
            (new MessageBox( msg, TITLE,
                             StdIcon_Error, StdButton_Ok )).execute();
         }
      }
      finally
      {
         try { Console.abortEnabled = false; } catch ( e ) {}
      }
   };


   this.done_PushButton = new PushButton( this );
   this.done_PushButton.text = "Done";
   this.done_PushButton.icon = this.scaledResource( ":/icons/ok.png" );
   this.done_PushButton.toolTip = "Close the dialog.";
   this.done_PushButton.onClick = function()
   {
      dialog.ok();
   };


   this.copyright_Label = new Label( this );
   this.copyright_Label.text = "© 2026 Brian Valente";
   this.copyright_Label.textAlignment = TextAlign_Left | TextAlign_VertCenter;


   var buttonSizer = new HorizontalSizer;
   buttonSizer.spacing = 6;
   buttonSizer.add( this.copyright_Label );
   buttonSizer.addStretch();
   buttonSizer.add( this.execute_PushButton );
   buttonSizer.add( this.done_PushButton );


   //
   // Outer
   //
   this.sizer = new VerticalSizer;
   this.sizer.margin = 6;
   this.sizer.spacing = 6;
   this.sizer.add( topSizer, 100 );
   this.sizer.add( buttonSizer );


   this.setScaledMinSize( 900, 600 );
   this.adjustToContents();


   // Default tool mode: when no mask geometry exists yet, drop the user
   // straight into Place Nucleus — that's the natural first action.
   // (M5 persistence will preload geometry and we'll switch to Edit Points
   // when geometry is present.)
   var hasGeometry = (this.preview.nucleus != null) ||
      (this.preview.tail != null && this.preview.tail.vertices.length > 0);
   this.setToolMode( hasGeometry ? TOOL_IDLE : TOOL_PLACE_NUCLEUS );


   // Initial enabled state for the metric-specific controls.
   this.applyTailMetricEnabledState();
}


CometMaskDialog.prototype = new Dialog;


// ----------------------------------------------------------------------------
// Small NumericEdit / NumericControl factories. Kept as free functions so the
// dialog body stays readable.
// ----------------------------------------------------------------------------


function makeNumericEdit( parent, label, value, lo, hi, decimals )
{
   var ne = new NumericEdit( parent );
   ne.label.text = label + ":";
   ne.setRange( lo, hi );
   ne.setPrecision( decimals );
   ne.setValue( value );
   ne.toolTip = label;
   return ne;
}


function makeNumericControl( parent, label, value, lo, hi, decimals )
{
   var nc = new NumericControl( parent );
   nc.label.text = label;
   nc.setRange( lo, hi );
   nc.setPrecision( decimals );
   // Slider range and width must be configured BEFORE setValue, otherwise
   // the slider gets positioned against the default range (0..50) and
   // doesn't re-sync when the range is widened — the visible thumb ends up
   // far from where the numeric edit shows the value.
   nc.slider.setRange( 0, 1000 );
   nc.slider.scaledMinWidth = 160;
   nc.setValue( value );
   nc.toolTip = label;
   return nc;
}


// 3-item ComboBox for the per-region "soften direction" picker. Default
// item is "Split" (index 2) — same effect as the unconditional Gaussian
// blur the engine did before the directional option existed.
function makeSoftenDirectionCombo( parent )
{
   var cb = new ComboBox( parent );
   cb.addItem( "Inward" );
   cb.addItem( "Outward" );
   cb.addItem( "Split" );
   cb.currentItem = 2;
   cb.toolTip =
      "Where the soften blur is allowed to spread:\n" +
      "  Inward: keeps the outer edge crisp; only smooths inside the region.\n" +
      "  Outward: keeps the interior gradient crisp; lets a soft halo bleed\n" +
      "    outside past the boundary.\n" +
      "  Split: blur goes both ways (default — same as a regular soft blur).";
   return cb;
}


// ----------------------------------------------------------------------------
// main()
// ----------------------------------------------------------------------------


function main()
{
   Console.show();
   Console.writeln( "<end><cbr><br>", TITLE, " v", VERSION );


   var window = ImageWindow.activeWindow;
   if ( window.isNull )
   {
      (new MessageBox(
         "There is no active image window. Open an image first.",
         TITLE, StdIcon_Warning, StdButton_Ok )).execute();
      return;
   }


   var view = window.currentView;
   if ( view.isNull || view.image.width < 1 || view.image.height < 1 )
   {
      (new MessageBox(
         "The active view has no image.",
         TITLE, StdIcon_Warning, StdButton_Ok )).execute();
      return;
   }


   var dlg = new CometMaskDialog( view );
   dlg.execute();
}


try
{
   main();
}
catch ( ex )
{
   Console.criticalln( "<end><cbr>*** ", TITLE, " error: ", ex.toString() );
}
